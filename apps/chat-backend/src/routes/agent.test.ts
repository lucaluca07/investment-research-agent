import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerAgentRoutes } from "./agent.js";
import { ResearchClientError } from "../research-client.js";

function setup() {
  const app = Fastify();
  const client = {
    listAguiEvents: vi.fn(async () => []),
    getAguiState: vi.fn(async () => ({
      thread: {
        id: "t",
        title: "",
        title_source: "",
        title_locked: false,
        created_at: "now",
      },
      last_event_seq: 0,
      runs: [],
    })),
  } as any;
  const controller = {
    start: vi.fn(async () => ({
      run: { id: "r", status: "running" },
      replayed: false,
      last_event_seq: 0,
      done: Promise.resolve(),
    })),
    subscribe: vi.fn(() => () => undefined),
    subscribeWithCompletion: vi.fn(),
    getActive: vi.fn(() => undefined),
    stop: vi.fn(async () => ({ id: "r", status: "cancelled" })),
  } as any;
  controller.subscribeWithCompletion.mockImplementation(
    (threadId: string, listener: (event: unknown) => void) => ({
      unsubscribe: controller.subscribe(threadId, listener),
      done: Promise.resolve(),
    }),
  );
  return { app, client, controller };
}

describe("AG-UI agent routes", () => {
  it("proxies thread discovery and creation through the durable research service", async () => {
    const { app, client, controller } = setup();
    client.listThreads = vi.fn(async () => [{ id: "t", title: "PCB", title_source: "user", title_locked: false, created_at: "now" }]);
    client.createThread = vi.fn(async (title: string, id?: string) => ({ id: id ?? "new", title, title_source: "user", title_locked: false, created_at: "now" }));
    await registerAgentRoutes(app, client, controller);

    expect((await app.inject({ method: "GET", url: "/v1/threads" })).json()).toEqual([expect.objectContaining({ id: "t" })]);
    const created = await app.inject({ method: "POST", url: "/v1/threads", payload: { id: "chosen", title: "AI PCB" } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: "chosen", title: "AI PCB" });
    expect(client.createThread).toHaveBeenCalledWith("AI PCB", "chosen");
  });

  it("proxies persisted run cancellation for the runtime agent", async () => {
    const { app, client, controller } = setup();
    client.transitionAguiRun = vi.fn(async () => ({ id: "run", status: "cancelled" }));
    await registerAgentRoutes(app, client, controller);

    const response = await app.inject({ method: "POST", url: "/v1/runs/run/transition", payload: { status: "cancelled" } });
    expect(response.statusCode).toBe(200);
    expect(client.transitionAguiRun).toHaveBeenCalledWith("run", "cancelled", undefined);
  });
  it("validates idempotency and exposes replay/state", async () => {
    const { app, client, controller } = setup();
    await registerAgentRoutes(app, client, controller);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/threads/t/runs",
          payload: { input: "x" },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (await app.inject({ method: "GET", url: "/v1/threads/t/events?after=2" }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/v1/threads/t/state" }))
        .statusCode,
    ).toBe(200);
    expect(client.listAguiEvents).toHaveBeenCalledWith("t", 2);
  });

  it("supports stop and standard run registration", async () => {
    const { app, controller } = setup();
    await registerAgentRoutes(app, {} as any, controller);
    expect(
      (await app.inject({ method: "POST", url: "/v1/threads/t/stop" }))
        .statusCode,
    ).toBe(200);
    expect(controller.stop).toHaveBeenCalledWith("t");
  });

  it("starts a run with JSON so the browser can subscribe separately", async () => {
    const { app, client, controller } = setup();
    client.listAguiEvents.mockResolvedValue([
      {
        thread_id: "t",
        sequence: 1,
        run_id: "r",
        type: "RUN_STARTED",
        data: {},
      },
    ]);
    await registerAgentRoutes(app, client, controller);
    const standard = await app.inject({
      method: "POST",
      url: "/v1/threads/t/runs",
      payload: { input: "x", idempotency_key: "k" },
    });
    expect(standard.statusCode).toBe(202);
    expect(standard.headers["content-type"]).toContain("application/json");
    expect(standard.json()).toMatchObject({ run: { id: "r" } });
    expect(controller.start).toHaveBeenCalledTimes(1);
    controller.start.mockRejectedValueOnce(
      new Error("thread already has an active run"),
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/threads/t/runs",
          payload: { input: "x", idempotency_key: "k3" },
        })
      ).statusCode,
    ).toBe(409);
  });

  it("accepts the standard AG-UI messages envelope and forwards its last user prompt", async () => {
    const { app, controller } = setup();
    await registerAgentRoutes(app, {} as any, controller);

    const response = await app.inject({
      method: "POST",
      url: "/v1/threads/t/runs",
      payload: {
        runId: "agui-run",
        idempotency_key: "standard-message",
        messages: [
          { id: "system", role: "system", content: "context" },
          { id: "user", role: "user", content: [{ type: "text", text: "research AI PCB" }] },
        ],
      },
    });

    expect(response.statusCode).toBe(202);
    expect(controller.start).toHaveBeenCalledWith(
      "t",
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "user", content: [{ type: "text", text: "research AI PCB" }] }),
        ]),
      }),
      "standard-message",
      undefined,
    );
  });

  it("rejects a standard AG-UI envelope without usable user content", async () => {
    const { app, controller } = setup();
    await registerAgentRoutes(app, {} as any, controller);

    const response = await app.inject({
      method: "POST",
      url: "/v1/threads/t/runs",
      payload: { idempotency_key: "empty-message", messages: [{ role: "user", content: [] }] },
    });

    expect(response.statusCode).toBe(422);
    expect(controller.start).not.toHaveBeenCalled();
  });

  it("keeps explicit input as the run input when AG-UI messages are also present", async () => {
    const { app, controller } = setup();
    await registerAgentRoutes(app, {} as any, controller);

    const response = await app.inject({
      method: "POST",
      url: "/v1/threads/t/runs",
      payload: { idempotency_key: "explicit-input", input: "explicit prompt", messages: [{ role: "user", content: "ignored" }] },
    });

    expect(response.statusCode).toBe(202);
    expect(controller.start).toHaveBeenCalledWith("t", "explicit prompt", "explicit-input", undefined);
  });

  it("closes the replay-subscribe window with sequence de-duplication", async () => {
    const { app, client, controller } = setup();
    let live: ((event: unknown) => void) | undefined;
    controller.subscribe.mockImplementation(
      (_thread: string, listener: (event: unknown) => void) => {
        live = listener;
        return () => undefined;
      },
    );
    client.listAguiEvents.mockImplementation(async () => {
      live?.({
        thread_id: "t",
        sequence: 2,
        run_id: "r",
        type: "TEXT_MESSAGE_CONTENT",
        data: { delta: "live" },
      });
      return [
        {
          thread_id: "t",
          sequence: 1,
          run_id: "r",
          type: "RUN_STARTED",
          data: {},
        },
        {
          thread_id: "t",
          sequence: 2,
          run_id: "r",
          type: "TEXT_MESSAGE_CONTENT",
          data: { delta: "replay" },
        },
      ];
    });
    await registerAgentRoutes(app, client, controller);
    const response = await app.inject({
      method: "GET",
      url: "/v1/threads/t/events",
    });
    expect(response.body.match(/TEXT_MESSAGE_CONTENT/g)?.length).toBe(1);
  });

  it("ends each active SSE subscription after its run so a later run on the thread can stream", async () => {
    const { app, client, controller } = setup();
    let current: {
      listener?: (event: unknown) => void;
      resolve?: () => void;
      done: Promise<void>;
    } | undefined;
    const begin = () => {
      let resolve!: () => void;
      current = {
        done: new Promise<void>((done) => {
          resolve = done;
        }),
        resolve,
      };
    };
    controller.getActive.mockImplementation(() =>
      current ? { id: "active", status: "running" } : undefined,
    );
    controller.subscribeWithCompletion = vi.fn(
      (_thread: string, listener: (event: unknown) => void) => {
        current!.listener = listener;
        return {
          unsubscribe: () => {
            if (current) current.listener = undefined;
          },
          done: current!.done,
        };
      },
    );
    client.listAguiEvents.mockResolvedValue([]);
    await registerAgentRoutes(app, client, controller);

    begin();
    const first = app.inject({ method: "GET", url: "/v1/threads/t/events" });
    await vi.waitFor(() => expect(current?.listener).toBeTypeOf("function"));
    current!.listener!({ sequence: 1, type: "RUN_STARTED", data: {} });
    current!.resolve!();
    current = undefined;
    expect((await first).body).toContain("RUN_STARTED");

    begin();
    const second = app.inject({ method: "GET", url: "/v1/threads/t/events?after=1" });
    await vi.waitFor(() => expect(current?.listener).toBeTypeOf("function"));
    current!.listener!({ sequence: 2, type: "RUN_STARTED", data: {} });
    current!.resolve!();
    current = undefined;
    const response = await second;
    expect(response.body).toContain("id: 2");
    expect(controller.subscribeWithCompletion).toHaveBeenCalledTimes(2);
  });

  it("resumes only from the server checkpoint, never browser supplied state", async () => {
    const { app, client, controller } = setup();
    client.getInterruptCheckpoint = vi.fn(async () => ({
      checkpoint_id: "cp",
      interrupt_id: "interrupt",
      run_id: "run",
      operation_id: "op",
      nonce: "server-nonce",
    }));
    const receipt = {
      interrupt_id: "interrupt",
      run_id: "run",
      operation_id: "op",
      checkpoint_id: "cp",
      receipt_id: "rr",
      status: "resolved",
      payload: { approved: true },
    };
    client.resolveInterruptSet = vi.fn(async () => ({
      thread_id: "t",
      receipts: [receipt],
      checkpoints: [await client.getInterruptCheckpoint()],
      replayed: false,
    }));
    controller.resumeRecoverySet = vi.fn(async () => ({
      recovery_run_id: "recovery",
      results: [],
    }));
    await registerAgentRoutes(app, client, controller);
    const response = await app.inject({
      method: "POST",
      url: "/v1/threads/t/interrupts/interrupt/resume",
      payload: {
        status: "resolved",
        payload: { approved: true },
        checkpoint: { run_id: "forged" },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(client.resolveInterruptSet).toHaveBeenCalledWith("t", [
      {
        interrupt_id: "interrupt",
        nonce: "server-nonce",
        status: "resolved",
        payload: { approved: true },
      },
    ]);
    expect(controller.resumeRecoverySet).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "t",
        checkpoints: [
          expect.objectContaining({ run_id: "run", nonce: "server-nonce" }),
        ],
        decisions: [receipt],
      }),
    );
  });

  it("rejects a partial decision set before starting recovery", async () => {
    const { app, client, controller } = setup();
    client.listOpenInterrupts = vi.fn(async () => [
      { interrupt_id: "i-1", run_id: "r", operation_id: "o-1" },
      { interrupt_id: "i-2", run_id: "r", operation_id: "o-2" },
    ]);
    client.resolveInterruptSet = vi.fn(async () => {
      throw new ResearchClientError("set mismatch", 409, {
        detail: "resume request must cover every open interrupt",
      });
    });
    controller.resumeRecoverySet = vi.fn();
    await registerAgentRoutes(app, client, controller);
    const response = await app.inject({
      method: "POST",
      url: "/v1/threads/t/interrupts/resume",
      payload: {
        decisions: [
          {
            interrupt_id: "i-1",
            nonce: "n-1",
            status: "resolved",
            payload: { approved: true },
          },
        ],
      },
    });
    expect(response.statusCode).toBe(409);
    expect(client.resolveInterruptSet).toHaveBeenCalled();
    expect(controller.resumeRecoverySet).not.toHaveBeenCalled();
  });

  it("atomically resolves every decision and recovers from service checkpoints only", async () => {
    const { app, client, controller } = setup();
    const checkpoints = [
      {
        checkpoint_id: "c1",
        interrupt_id: "i-1",
        run_id: "r",
        operation_id: "o-1",
        nonce: "n-1",
        tool_call_id: "tc-1",
        last_event_seq: 1,
        last_event: { type: "X", data: {} },
        session: null,
      },
      {
        checkpoint_id: "c2",
        interrupt_id: "i-2",
        run_id: "r",
        operation_id: "o-2",
        nonce: "n-2",
        tool_call_id: "tc-2",
        last_event_seq: 2,
        last_event: { type: "X", data: {} },
        session: null,
      },
    ];
    client.listOpenInterrupts = vi.fn(async () =>
      checkpoints.map(({ interrupt_id, run_id, operation_id }) => ({
        interrupt_id,
        run_id,
        operation_id,
      })),
    );
    client.resolveInterruptSet = vi.fn(async () => ({
      thread_id: "t",
      receipts: [
        {
          interrupt_id: "i-1",
          run_id: "r",
          operation_id: "o-1",
          checkpoint_id: "c1",
          receipt_id: "rr1",
          status: "resolved",
          payload: { approved: true },
        },
        {
          interrupt_id: "i-2",
          run_id: "r",
          operation_id: "o-2",
          checkpoint_id: "c2",
          receipt_id: "rr2",
          status: "resolved",
          payload: { approved: false },
        },
      ],
      checkpoints,
      replayed: false,
    }));
    controller.resumeRecoverySet = vi.fn(async () => ({
      recovery_run_id: "recovery",
      results: [],
    }));
    await registerAgentRoutes(app, client, controller);
    const decisions = [
      {
        interrupt_id: "i-1",
        nonce: "n-1",
        status: "resolved",
        payload: { approved: true },
        checkpoint: { run_id: "forged" },
      },
      {
        interrupt_id: "i-2",
        nonce: "n-2",
        status: "resolved",
        payload: { approved: false },
      },
    ];
    const response = await app.inject({
      method: "POST",
      url: "/v1/threads/t/interrupts/resume",
      payload: { decisions },
    });
    expect(response.statusCode).toBe(200);
    expect(client.resolveInterruptSet).toHaveBeenCalledWith(
      "t",
      decisions.map(({ checkpoint: _ignored, ...decision }) => decision),
    );
    expect(controller.resumeRecoverySet).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "t",
        checkpoints,
        decisions: expect.any(Array),
      }),
    );
  });
});
