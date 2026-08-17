import { EventType } from "@ag-ui/core";
import { describe, expect, it, vi } from "vitest";
import { RunController } from "./run-controller.js";

function client() {
  let seq = 0;
  return {
    createAguiRun: vi.fn(async (thread_id: string, _input: unknown, idempotency_key: string) => ({ run: { id: "run-1", thread_id, idempotency_key, status: "running", model: null }, replayed: false, last_event_seq: 1 })),
    appendAguiEvents: vi.fn(async (thread_id: string, run_id: string, events: any[]) => ({ events: events.map((event) => ({ thread_id, run_id, sequence: ++seq, ...event })) })),
    transitionAguiRun: vi.fn(async (id: string, status: any) => ({ id, thread_id: "thread-1", idempotency_key: "key", status, model: null })),
  } as any;
}

describe("RunController", () => {
  it("persists Pi events and finishes successfully", async () => {
    const c = client(); let listener: ((event: unknown) => void) | undefined; const prompt = vi.fn(async () => { listener?.({ type: "message_start", message: { role: "assistant", content: [] } }); listener?.({ type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ok", partial: { role: "assistant", content: [] } } }); listener?.({ type: "message_end", message: { role: "assistant", content: [] } }); });
    const controller = new RunController({ client: c, sessionFactory: async () => ({ prompt, subscribe: (fn) => { listener = fn; return () => { listener = undefined; }; } }) });
    await (await controller.start("thread-1", "hello", "key")).done;
    expect(prompt).toHaveBeenCalledWith("hello"); expect(c.appendAguiEvents).toHaveBeenCalled(); expect(c.transitionAguiRun).toHaveBeenCalledWith("run-1", "completed", undefined, false);
    expect(c.appendAguiEvents.mock.calls.flatMap((call: any[]) => call[2]).some((event: any) => event.type === EventType.RUN_FINISHED)).toBe(true);
  });

  it("aborts and persists non-retryable cancellation", async () => {
    const c = client(); let resolve!: () => void; const prompt = vi.fn(() => new Promise<void>((r) => { resolve = r; })); const abort = vi.fn(async () => resolve());
    const controller = new RunController({ client: c, sessionFactory: async () => ({ prompt, abort, subscribe: () => () => undefined }) });
    const started = await controller.start("thread-1", "hello", "key"); await controller.stop("thread-1"); await started.done;
    expect(abort).toHaveBeenCalled(); expect(c.transitionAguiRun).toHaveBeenCalledWith("run-1", "cancelled", { code: "run_cancelled", retryable: false }, false);
  });

  it("fails the persisted run when session initialization fails", async () => {
    const c = client(); const controller = new RunController({ client: c, sessionFactory: async () => { throw new Error("model unavailable"); } });
    await expect(controller.start("thread-1", "hello", "key")).rejects.toThrow("model unavailable");
    expect(c.appendAguiEvents).toHaveBeenCalledWith("thread-1", "run-1", [{ type: EventType.RUN_ERROR, data: { runId: "run-1", message: "model unavailable", code: "run_failed" } }]);
    expect(c.transitionAguiRun).toHaveBeenCalledWith("run-1", "failed", { message: "model unavailable", retryable: false }, false);
  });

  it("rejects concurrent starts for one thread before persistence", async () => {
    const c = client(); let release!: () => void; c.createAguiRun.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ run: { id: "r", thread_id: "thread-1", idempotency_key: "k", status: "running", model: null }, replayed: false, last_event_seq: 1 }); }));
    const controller = new RunController({ client: c, sessionFactory: async () => ({ prompt: async () => undefined, subscribe: () => () => undefined }) });
    const first = controller.start("thread-1", "a", "k"); await expect(controller.start("thread-1", "b", "k2")).rejects.toThrow(/active/); release(); await (await first).done;
  });

  it("persists failure when session subscription setup throws", async () => {
    const c = client(); const controller = new RunController({ client: c, sessionFactory: async () => ({ prompt: async () => undefined, subscribe: () => { throw new Error("subscribe failed"); } }) });
    await expect(controller.start("thread-1", "hello", "key")).rejects.toThrow("subscribe failed");
    expect(c.transitionAguiRun).toHaveBeenCalledWith("run-1", "failed", { message: "subscribe failed", retryable: false }, false);
  });

  it("publishes a durable run error on the interrupted run when ordinary input arrives", async () => {
    const c = client();
    const controller = new RunController({ client: c, sessionFactory: async () => ({ prompt: async () => undefined, subscribe: () => () => undefined }) });
    controller.registerInterrupt("thread-1", "interrupt-1", "run-interrupted");
    await expect(controller.start("thread-1", "ordinary input", "key")).rejects.toThrow(/open interrupt/);
    expect(c.appendAguiEvents).toHaveBeenCalledWith("thread-1", "run-interrupted", [expect.objectContaining({ type: EventType.RUN_ERROR })]);
  });
});
