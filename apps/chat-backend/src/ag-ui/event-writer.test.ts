import { EventType, type AGUIEvent } from "@ag-ui/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AguiEvent } from "../research-client.js";
import { EventWriter } from "./event-writer.js";

type InputEvent = AGUIEvent;
type PersistableEvent = { type: string; data: Record<string, unknown> };

function persisted(sequence: number, event: InputEvent): AguiEvent {
  const { type, ...data } = event;
  return { thread_id: "thread-1", run_id: "run-1", sequence, type, data };
}

function setup() {
  let sequence = 0;
  const appendEventBatch = vi.fn(async (_threadId: string, _runId: string, events: PersistableEvent[]) => ({
    events: events.map((event) => ({
      thread_id: "thread-1",
      run_id: "run-1",
      sequence: ++sequence,
      type: event.type,
      data: event.data,
    })),
  }));
  const emit = vi.fn();
  const writer = new EventWriter({ threadId: "thread-1", runId: "run-1", appendEventBatch, emit });
  return { writer, appendEventBatch, emit };
}

afterEach(() => vi.useRealTimers());

describe("EventWriter", () => {
  it("flushes text content after 50ms", async () => {
    vi.useFakeTimers();
    const { writer, appendEventBatch, emit } = setup();
    const pending = writer.write({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "a" });
    expect(appendEventBatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(49);
    expect(appendEventBatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(appendEventBatch).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("flushes text content when the UTF-8 batch reaches 2KB", async () => {
    const { writer, appendEventBatch } = setup();
    await writer.write({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "é".repeat(1024) });
    expect(appendEventBatch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { type: EventType.TOOL_CALL_START, toolCallId: "c1", toolCallName: "query" } as const,
    { type: EventType.STATE_SNAPSHOT, snapshot: { phase: "working" } } as const,
    { type: EventType.RUN_FINISHED, threadId: "thread-1", runId: "run-1", outcome: { type: "success", result: "done" } } as const,
  ])("flushes pending text before $type", async (boundary) => {
    const { writer, appendEventBatch } = setup();
    const text = writer.write({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "a" });
    await writer.write(boundary);
    await text;
    expect(appendEventBatch.mock.calls.map((call) => call[2].map((event: PersistableEvent) => event.type))).toEqual([
      [EventType.TEXT_MESSAGE_CONTENT],
      [boundary.type],
    ]);
  });

  it("serializes concurrent writes for one thread and emits persisted sequence order", async () => {
    let releaseFirst!: (value: { events: AguiEvent[] }) => void;
    const firstResult = new Promise<{ events: AguiEvent[] }>((resolve) => { releaseFirst = resolve; });
    const appendEventBatch = vi.fn()
      .mockImplementationOnce(() => firstResult)
      .mockResolvedValueOnce({ events: [persisted(2, { type: EventType.STEP_FINISHED, stepName: "two" })] });
    const emit = vi.fn();
    const writer = new EventWriter({ threadId: "thread-1", runId: "run-1", appendEventBatch, emit });

    const first = writer.write({ type: EventType.STEP_STARTED, stepName: "one" });
    const second = writer.write({ type: EventType.STEP_FINISHED, stepName: "two" });
    await vi.waitFor(() => expect(appendEventBatch).toHaveBeenCalledTimes(1));
    releaseFirst({ events: [persisted(1, { type: EventType.STEP_STARTED, stepName: "one" })] });
    await Promise.all([first, second]);
    expect(appendEventBatch).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls.map(([event]) => event.sequence)).toEqual([1, 2]);
  });

  it("does not emit events rejected by persistence", async () => {
    const appendEventBatch = vi.fn().mockRejectedValue(new Error("database unavailable"));
    const emit = vi.fn();
    const writer = new EventWriter({ threadId: "thread-1", runId: "run-1", appendEventBatch, emit });
    await expect(writer.write({ type: EventType.STEP_STARTED, stepName: "one" })).rejects.toThrow("database unavailable");
    expect(emit).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "wrong thread",
      response: [{ ...persisted(1, { type: EventType.STEP_STARTED, stepName: "one" }), thread_id: "thread-2" }],
    },
    {
      label: "wrong run",
      response: [{ ...persisted(1, { type: EventType.STEP_STARTED, stepName: "one" }), run_id: "run-2" }],
    },
    { label: "missing event", response: [] },
    {
      label: "extra event",
      response: [
        persisted(1, { type: EventType.STEP_STARTED, stepName: "one" }),
        persisted(2, { type: EventType.STEP_STARTED, stepName: "one" }),
      ],
    },
    {
      label: "tampered type",
      response: [persisted(1, { type: EventType.STEP_FINISHED, stepName: "one" })],
    },
    {
      label: "tampered data",
      response: [persisted(1, { type: EventType.STEP_STARTED, stepName: "changed" })],
    },
  ])("rejects a persistence response with $label before emitting", async ({ response }) => {
    const appendEventBatch = vi.fn().mockResolvedValue({ events: response });
    const emit = vi.fn();
    const writer = new EventWriter({ threadId: "thread-1", runId: "run-1", appendEventBatch, emit });
    await expect(writer.write({ type: EventType.STEP_STARTED, stepName: "one" })).rejects.toThrow(/persistence response/);
    expect(emit).not.toHaveBeenCalled();
  });

  it("rejects reordered or non-contiguous persistence sequences before emitting", async () => {
    const appendEventBatch = vi.fn().mockResolvedValue({
      events: [
        persisted(2, { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "a" }),
        persisted(1, { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "b" }),
      ],
    });
    const emit = vi.fn();
    const writer = new EventWriter({ threadId: "thread-1", runId: "run-1", appendEventBatch, emit });
    const first = writer.write({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "a" });
    const second = writer.write({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "b" });
    await expect(writer.flush()).rejects.toThrow(/persistence response/);
    await expect(first).rejects.toThrow(/persistence response/);
    await expect(second).rejects.toThrow(/persistence response/);
    expect(emit).not.toHaveBeenCalled();
  });

  it("flushes pending text before close and rejects later writes", async () => {
    const { writer, appendEventBatch } = setup();
    const pending = writer.write({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "last" });
    await writer.close();
    await pending;
    expect(appendEventBatch).toHaveBeenCalledTimes(1);
    await expect(writer.write({ type: EventType.STEP_STARTED, stepName: "late" })).rejects.toThrow(/closed/);
  });
});
