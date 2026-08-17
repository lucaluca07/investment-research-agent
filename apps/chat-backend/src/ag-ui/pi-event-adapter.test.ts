import { EventType } from "@ag-ui/core";
import { describe, expect, it } from "vitest";

import { PiEventAdapter } from "./pi-event-adapter.js";

describe("PiEventAdapter", () => {
  it("maps assistant text lifecycle with one stable message id", () => {
    const adapter = new PiEventAdapter({ createId: () => "message-1" });

    expect(adapter.adapt({ type: "message_start", message: { role: "assistant", content: [] } })).toEqual([
      { type: EventType.TEXT_MESSAGE_START, messageId: "message-1", role: "assistant" },
    ]);
    expect(adapter.adapt({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello", partial: { role: "assistant", content: [] } },
    })).toEqual([
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "message-1", delta: "hello" },
    ]);
    expect(adapter.adapt({ type: "message_end", message: { role: "assistant", content: [] } })).toEqual([
      { type: EventType.TEXT_MESSAGE_END, messageId: "message-1" },
    ]);
  });

  it.each([false, true])("maps tool start, arguments, end, and result in protocol order with isError=%s", (isError) => {
    const adapter = new PiEventAdapter({ createId: () => "tool-result-1" });
    const result = { content: [{ type: "text", text: "ok" }], details: { ok: true } };

    expect(adapter.adapt({ type: "tool_execution_start", toolCallId: "call-1", toolName: "query", args: { ticker: "300476.SZ" } })).toEqual([
      { type: EventType.TOOL_CALL_START, toolCallId: "call-1", toolCallName: "query" },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "call-1", delta: JSON.stringify({ ticker: "300476.SZ" }) },
      { type: EventType.TOOL_CALL_END, toolCallId: "call-1" },
    ]);
    expect(adapter.adapt({ type: "tool_execution_end", toolCallId: "call-1", toolName: "query", result, isError })).toEqual([
      {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "call-1",
        messageId: "tool-result-1",
        content: JSON.stringify({ result, isError }),
        role: "tool",
      },
    ]);
  });

  it("maps Pi turn boundaries to step events", () => {
    const adapter = new PiEventAdapter();
    expect(adapter.adapt({ type: "turn_start" })).toEqual([{ type: EventType.STEP_STARTED, stepName: "agent-turn" }]);
    expect(adapter.adapt({ type: "turn_end", message: {}, toolResults: [] })).toEqual([{ type: EventType.STEP_FINISHED, stepName: "agent-turn" }]);
  });

  it("ignores unknown Pi events", () => {
    expect(new PiEventAdapter().adapt({ type: "future_pi_event" })).toEqual([]);
  });

  it.each([
    { type: "message_start", message: { role: "assistant" } },
    { type: "message_start", message: { role: "invalid", content: [] } },
    { type: "message_end", message: { role: "assistant", content: "damaged" } },
    { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "not_a_pi_subtype" } },
    { type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: {} } },
    { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta" } },
    { type: "message_end", message: {} },
    { type: "tool_execution_start", toolName: "query", args: {} },
    { type: "tool_execution_update", toolCallId: "call-1", toolName: "query", args: undefined, partialResult: {} },
    { type: "tool_execution_update", toolCallId: "call-1", toolName: "query", args: {}, partialResult: undefined },
    { type: "tool_execution_update", toolCallId: "call-1", toolName: "query", args: "not-an-object", partialResult: {} },
    { type: "tool_execution_update", toolCallId: "call-1", toolName: "query", args: {}, partialResult: {} },
    { type: "tool_execution_end", toolCallId: "call-1", toolName: "query", isError: false },
  ])("rejects malformed known events: $type", (event) => {
    expect(() => new PiEventAdapter().adapt(event)).toThrow(/Malformed Pi event/);
  });

  it.each([
    { invalid: { nested: undefined }, label: "nested undefined" },
    { invalid: { nested: () => "no" }, label: "function" },
    { invalid: { nested: Symbol("no") }, label: "symbol" },
    { invalid: { nested: Number.NaN }, label: "NaN" },
    { invalid: { nested: Number.POSITIVE_INFINITY }, label: "Infinity" },
  ])("rejects non-JSON tool arguments containing $label", ({ invalid }) => {
    expect(() => new PiEventAdapter().adapt({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "query",
      args: invalid,
    })).toThrow(/Malformed Pi event/);
  });

  it("rejects cyclic JSON values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => new PiEventAdapter().adapt({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "query",
      args: cyclic,
    })).toThrow(/Malformed Pi event/);
  });
});
