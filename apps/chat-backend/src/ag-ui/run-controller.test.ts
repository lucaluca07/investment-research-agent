import { EventType } from "@ag-ui/core";
import { describe, expect, it, vi } from "vitest";
import { RunController } from "./run-controller.js";

function client() {
  let seq = 0;
  return {
    createAguiRun: vi.fn(
      async (thread_id: string, _input: unknown, idempotency_key: string) => ({
        run: {
          id: "run-1",
          thread_id,
          idempotency_key,
          status: "running",
          model: null,
        },
        replayed: false,
        last_event_seq: 1,
      }),
    ),
    appendAguiEvents: vi.fn(
      async (thread_id: string, run_id: string, events: any[]) => ({
        events: events.map((event) => ({
          thread_id,
          run_id,
          sequence: ++seq,
          ...event,
        })),
      }),
    ),
    transitionAguiRun: vi.fn(async (id: string, status: any) => ({
      id,
      thread_id: "thread-1",
      idempotency_key: "key",
      status,
      model: null,
    })),
  } as any;
}

describe("RunController", () => {
  it("persists Pi events and finishes successfully", async () => {
    const c = client();
    let listener: ((event: unknown) => void) | undefined;
    const prompt = vi.fn(async () => {
      listener?.({
        type: "message_start",
        message: { role: "assistant", content: [] },
      });
      listener?.({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "ok",
          partial: { role: "assistant", content: [] },
        },
      });
      listener?.({
        type: "message_end",
        message: { role: "assistant", content: [] },
      });
    });
    const controller = new RunController({
      client: c,
      sessionFactory: async () => ({
        prompt,
        subscribe: (fn) => {
          listener = fn;
          return () => {
            listener = undefined;
          };
        },
      }),
    });
    await (
      await controller.start("thread-1", "hello", "key")
    ).done;
    expect(prompt).toHaveBeenCalledWith("hello");
    expect(c.appendAguiEvents).toHaveBeenCalled();
    expect(c.transitionAguiRun).toHaveBeenCalledWith(
      "run-1",
      "completed",
      undefined,
      false,
    );
    expect(
      c.appendAguiEvents.mock.calls
        .flatMap((call: any[]) => call[2])
        .some((event: any) => event.type === EventType.RUN_FINISHED),
    ).toBe(true);
  });

  it("prompts Pi with the last user text from standard AG-UI message parts", async () => {
    const c = client();
    const prompt = vi.fn(async () => undefined);
    const controller = new RunController({
      client: c,
      sessionFactory: async () => ({ prompt, subscribe: () => () => undefined }),
    });

    await (await controller.start("thread-1", {
      messages: [
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: [{ type: "text", text: "research high-end PCB" }] },
      ],
    }, "message-parts")).done;

    expect(prompt).toHaveBeenCalledWith("research high-end PCB");
  });

  it("aborts and persists non-retryable cancellation", async () => {
    const c = client();
    let resolve!: () => void;
    const prompt = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    const abort = vi.fn(async () => resolve());
    const controller = new RunController({
      client: c,
      sessionFactory: async () => ({
        prompt,
        abort,
        subscribe: () => () => undefined,
      }),
    });
    const started = await controller.start("thread-1", "hello", "key");
    await controller.stop("thread-1");
    await started.done;
    expect(abort).toHaveBeenCalled();
    expect(c.transitionAguiRun).toHaveBeenCalledWith(
      "run-1",
      "cancelled",
      { code: "run_cancelled", retryable: false },
      false,
    );
  });

  it("fails the persisted run when session initialization fails", async () => {
    const c = client();
    const controller = new RunController({
      client: c,
      sessionFactory: async () => {
        throw new Error("model unavailable");
      },
    });
    await expect(controller.start("thread-1", "hello", "key")).rejects.toThrow(
      "model unavailable",
    );
    expect(c.appendAguiEvents).toHaveBeenCalledWith("thread-1", "run-1", [
      {
        type: EventType.RUN_ERROR,
        data: {
          runId: "run-1",
          message: "model unavailable",
          code: "run_failed",
        },
      },
    ]);
    expect(c.transitionAguiRun).toHaveBeenCalledWith(
      "run-1",
      "failed",
      { message: "model unavailable", retryable: false },
      false,
    );
  });

  it("rejects concurrent starts for one thread before persistence", async () => {
    const c = client();
    let release!: () => void;
    c.createAguiRun.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              run: {
                id: "r",
                thread_id: "thread-1",
                idempotency_key: "k",
                status: "running",
                model: null,
              },
              replayed: false,
              last_event_seq: 1,
            });
        }),
    );
    const controller = new RunController({
      client: c,
      sessionFactory: async () => ({
        prompt: async () => undefined,
        subscribe: () => () => undefined,
      }),
    });
    const first = controller.start("thread-1", "a", "k");
    await expect(controller.start("thread-1", "b", "k2")).rejects.toThrow(
      /active/,
    );
    release();
    await (
      await first
    ).done;
  });

  it("persists failure when session subscription setup throws", async () => {
    const c = client();
    const controller = new RunController({
      client: c,
      sessionFactory: async () => ({
        prompt: async () => undefined,
        subscribe: () => {
          throw new Error("subscribe failed");
        },
      }),
    });
    await expect(controller.start("thread-1", "hello", "key")).rejects.toThrow(
      "subscribe failed",
    );
    expect(c.transitionAguiRun).toHaveBeenCalledWith(
      "run-1",
      "failed",
      { message: "subscribe failed", retryable: false },
      false,
    );
  });

  it("publishes a durable run error on the interrupted run when ordinary input arrives", async () => {
    const c = client();
    const controller = new RunController({
      client: c,
      sessionFactory: async () => ({
        prompt: async () => undefined,
        subscribe: () => () => undefined,
      }),
    });
    controller.registerInterrupt("thread-1", "interrupt-1", "run-interrupted");
    await expect(
      controller.start("thread-1", "ordinary input", "key"),
    ).rejects.toThrow(/open interrupt/);
    expect(c.appendAguiEvents).toHaveBeenCalledWith(
      "thread-1",
      "run-interrupted",
      [expect.objectContaining({ type: EventType.RUN_ERROR })],
    );
  });

  it("recovers an atomic decision set in one durable run and replays only original tool result ids", async () => {
    const c = client();
    c.operationStatus = vi.fn(async (_thread: string, operation: string) =>
      operation === "o-1"
        ? { id: operation, status: "approved" }
        : { id: operation, status: "rejected" },
    );
    c.beginOperation = vi.fn(async () => ({}));
    c.completeOperation = vi.fn(async () => ({}));
    const execute = vi.fn(async () => ({ saved: true }));
    const controller = new RunController({
      client: c,
      operationExecutor: execute,
    });
    const result = await controller.resumeRecoverySet({
      threadId: "thread-1",
      checkpoints: [
        {
          checkpoint_id: "c1",
          interrupt_id: "i1",
          run_id: "old",
          operation_id: "o-1",
          nonce: "n1",
          tool_call_id: "tc-1",
          tool_name: "save",
          input: { x: 1 },
          messages: [{ role: "user", content: "original" }],
          evidence: [{ id: "e1" }],
          last_event_seq: 1,
          last_event: { type: "X", data: {} },
          session: null,
        },
        {
          checkpoint_id: "c2",
          interrupt_id: "i2",
          run_id: "old",
          operation_id: "o-2",
          nonce: "n2",
          tool_call_id: "tc-2",
          tool_name: "delete",
          input: {},
          messages: [{ role: "user", content: "original" }],
          evidence: [{ id: "e1" }],
          last_event_seq: 2,
          last_event: { type: "X", data: {} },
          session: null,
        },
      ],
      decisions: [
        {
          interrupt_id: "i1",
          run_id: "old",
          operation_id: "o-1",
          checkpoint_id: "c1",
          receipt_id: "rr1",
          status: "resolved",
          payload: { approved: true },
        },
        {
          interrupt_id: "i2",
          run_id: "old",
          operation_id: "o-2",
          checkpoint_id: "c2",
          receipt_id: "rr2",
          status: "resolved",
          payload: { approved: false },
        },
      ],
    });
    expect(result.recovery_run_id).toBe("run-1");
    expect(c.createAguiRun).toHaveBeenCalledWith(
      "thread-1",
      expect.objectContaining({
        recovery: "recovery_fallback",
        messages: [{ role: "user", content: "original" }],
        evidence: [{ id: "e1" }],
      }),
      expect.stringContaining("rr1"),
    );
    const persisted = c.appendAguiEvents.mock.calls.flatMap(
      (call: any[]) => call[2],
    );
    expect(
      persisted
        .filter((event: any) => event.type === EventType.TOOL_CALL_RESULT)
        .map((event: any) => event.data.toolCallId),
    ).toEqual(["tc-1", "tc-2"]);
    expect(
      persisted.some((event: any) =>
        [
          EventType.TOOL_CALL_START,
          EventType.TOOL_CALL_ARGS,
          EventType.TOOL_CALL_END,
        ].includes(event.type),
      ),
    ).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not execute or append events when the durable recovery run is replayed after restart", async () => {
    const c = client();
    c.createAguiRun.mockResolvedValueOnce({
      run: {
        id: "existing",
        thread_id: "thread-1",
        idempotency_key: "recovery-set:rr",
        status: "completed",
        model: null,
      },
      replayed: true,
      last_event_seq: 8,
    });
    c.operationStatus = vi.fn(async () => ({
      id: "o",
      status: "succeeded",
      result: { saved: true },
    }));
    const execute = vi.fn();
    const controller = new RunController({
      client: c,
      operationExecutor: execute,
    });
    const result = await controller.resumeRecoverySet({
      threadId: "thread-1",
      checkpoints: [
        {
          checkpoint_id: "c",
          interrupt_id: "i",
          run_id: "old",
          operation_id: "o",
          nonce: "n",
          tool_call_id: "tc",
          last_event_seq: 1,
          last_event: { type: "X", data: {} },
          session: null,
        },
      ],
      decisions: [
        {
          interrupt_id: "i",
          run_id: "old",
          operation_id: "o",
          checkpoint_id: "c",
          receipt_id: "rr",
          status: "resolved",
          payload: { approved: true },
        },
      ],
    });
    expect(result).toEqual({
      recovery_run_id: "existing",
      results: [{ operation_id: "o", result: { saved: true } }],
    });
    expect(execute).not.toHaveBeenCalled();
    expect(c.appendAguiEvents).not.toHaveBeenCalled();
  });

  it("does not mutate an in-flight durable recovery when a concurrent retry arrives", async () => {
    const c = client();
    c.createAguiRun.mockResolvedValueOnce({
      run: {
        id: "existing",
        thread_id: "thread-1",
        idempotency_key: "recovery-set:rr",
        status: "running",
        model: null,
      },
      replayed: true,
      last_event_seq: 4,
    });
    c.operationStatus = vi.fn(async () => ({ id: "o", status: "executing" }));
    const controller = new RunController({
      client: c,
      operationExecutor: vi.fn(),
    });
    await expect(
      controller.resumeRecoverySet({
        threadId: "thread-1",
        checkpoints: [
          {
            checkpoint_id: "c",
            interrupt_id: "i",
            run_id: "old",
            operation_id: "o",
            nonce: "n",
            tool_call_id: "tc",
            last_event_seq: 1,
            last_event: { type: "X", data: {} },
            session: null,
          },
        ],
        decisions: [
          {
            interrupt_id: "i",
            run_id: "old",
            operation_id: "o",
            checkpoint_id: "c",
            receipt_id: "rr",
            status: "resolved",
            payload: { approved: true },
          },
        ],
      }),
    ).rejects.toThrow(/already in progress/);
    expect(c.beginOperation).toBeUndefined();
    expect(c.completeOperationError).toBeUndefined();
    expect(c.appendAguiEvents).not.toHaveBeenCalled();
    expect(c.transitionAguiRun).not.toHaveBeenCalled();
  });

  it("persists RUN_ERROR and failed operation/run when recovery execution fails", async () => {
    const c = client();
    c.operationStatus = vi.fn(async () => ({ id: "o", status: "approved" }));
    c.beginOperation = vi.fn(async () => ({}));
    c.completeOperationError = vi.fn(async () => ({}));
    const controller = new RunController({
      client: c,
      operationExecutor: async () => {
        throw new Error("disk full");
      },
    });
    await expect(
      controller.resumeRecoverySet({
        threadId: "thread-1",
        checkpoints: [
          {
            checkpoint_id: "c",
            interrupt_id: "i",
            run_id: "old",
            operation_id: "o",
            nonce: "n",
            tool_call_id: "tc",
            last_event_seq: 1,
            last_event: { type: "X", data: {} },
            session: null,
          },
        ],
        decisions: [
          {
            interrupt_id: "i",
            run_id: "old",
            operation_id: "o",
            checkpoint_id: "c",
            receipt_id: "rr",
            status: "resolved",
            payload: { approved: true },
          },
        ],
      }),
    ).rejects.toThrow("disk full");
    expect(c.completeOperationError).toHaveBeenCalledWith("thread-1", "o", {
      message: "disk full",
    });
    expect(c.transitionAguiRun).toHaveBeenCalledWith(
      "run-1",
      "failed",
      { message: "disk full", retryable: false },
      true,
      {
        type: EventType.RUN_ERROR,
        data: { runId: "run-1", message: "disk full", code: "recovery_failed" },
      },
    );
  });

  it("never persists RUN_FINISHED before a completed transition succeeds", async () => {
    const c = client();
    c.operationStatus = vi.fn(async () => ({
      id: "o",
      status: "succeeded",
      result: "ok",
    }));
    c.transitionAguiRun
      .mockRejectedValueOnce(new Error("transition unavailable"))
      .mockResolvedValueOnce({ id: "run-1", status: "failed" });
    const controller = new RunController({ client: c });
    await expect(
      controller.resumeRecoverySet({
        threadId: "thread-1",
        checkpoints: [
          {
            checkpoint_id: "c",
            interrupt_id: "i",
            run_id: "old",
            operation_id: "o",
            nonce: "n",
            tool_call_id: "tc",
            last_event_seq: 1,
            last_event: { type: "X", data: {} },
            session: null,
          },
        ],
        decisions: [
          {
            interrupt_id: "i",
            run_id: "old",
            operation_id: "o",
            checkpoint_id: "c",
            receipt_id: "rr",
            status: "resolved",
            payload: { approved: true },
          },
        ],
      }),
    ).rejects.toThrow("transition unavailable");
    const terminalTypes = c.appendAguiEvents.mock.calls
      .flatMap((call: any[]) => call[2])
      .map((event: any) => event.type)
      .filter(
        (type: string) =>
          type === EventType.RUN_FINISHED || type === EventType.RUN_ERROR,
      );
    expect(terminalTypes).toEqual([]);
    expect(c.transitionAguiRun).toHaveBeenNthCalledWith(
      1,
      "run-1",
      "completed",
      undefined,
      true,
      {
        type: EventType.RUN_FINISHED,
        data: { runId: "run-1", outcome: { type: "success" } },
      },
    );
    expect(c.transitionAguiRun).toHaveBeenLastCalledWith(
      "run-1",
      "failed",
      { message: "transition unavailable", retryable: false },
      true,
      {
        type: EventType.RUN_ERROR,
        data: {
          runId: "run-1",
          message: "transition unavailable",
          code: "recovery_failed",
        },
      },
    );
  });
});
