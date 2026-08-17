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
    stop: vi.fn(async () => ({ id: "r", status: "cancelled" })),
  } as any;
  return { app, client, controller };
}

describe("AG-UI agent routes", () => {
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

  it("serves standard and compatibility SSE paths and maps active conflict", async () => {
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
    expect(standard.statusCode).toBe(200);
    expect(standard.headers["content-type"]).toContain("text/event-stream");
    const alias = await app.inject({
      method: "POST",
      url: "/v1/threads/t/runs/stream",
      payload: { input: "x", idempotency_key: "k2" },
    });
    expect(alias.statusCode).toBe(200);
    expect(controller.start).toHaveBeenCalledTimes(2);
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
      method: "POST",
      url: "/v1/threads/t/runs",
      payload: { input: "x", idempotency_key: "k" },
    });
    expect(response.body.match(/TEXT_MESSAGE_CONTENT/g)?.length).toBe(1);
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
