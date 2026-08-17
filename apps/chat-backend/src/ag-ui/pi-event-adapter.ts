import {
  EventType,
  type StepFinishedEvent,
  type StepStartedEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type TextMessageStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallResultEvent,
  type ToolCallStartEvent,
} from "@ag-ui/core";

export type AdaptedPiEvent =
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | StepStartedEvent
  | StepFinishedEvent;

export type PiEventAdapterOptions = {
  createId?: () => string;
};

const KNOWN_PI_EVENTS = new Set([
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
]);

export class PiEventAdapter {
  private readonly createId: () => string;
  private nextId = 0;
  private activeAssistantMessageId: string | undefined;

  constructor(options: PiEventAdapterOptions = {}) {
    this.createId = options.createId ?? (() => `pi-message-${++this.nextId}`);
  }

  adapt(input: unknown): AdaptedPiEvent[] {
    if (!isRecord(input) || typeof input.type !== "string") return [];
    if (!KNOWN_PI_EVENTS.has(input.type)) return [];

    switch (input.type) {
      case "turn_start":
        return [{ type: EventType.STEP_STARTED, stepName: "agent-turn" }];
      case "turn_end":
        requireRecord(input.message, input.type);
        if (!Array.isArray(input.toolResults)) malformed(input.type);
        return [{ type: EventType.STEP_FINISHED, stepName: "agent-turn" }];
      case "message_start":
        return this.onMessageStart(input);
      case "message_update":
        return this.onMessageUpdate(input);
      case "message_end":
        return this.onMessageEnd(input);
      case "tool_execution_start":
        return this.onToolStart(input);
      case "tool_execution_update":
        this.requireToolIdentity(input);
        requireJsonRecord(input.args, input.type);
        validateToolResult(input.partialResult, input.type);
        return [];
      case "tool_execution_end":
        return this.onToolEnd(input);
    }
    return [];
  }

  private onMessageStart(input: Record<string, unknown>): AdaptedPiEvent[] {
    const message = requireRecord(input.message, input.type as string);
    validateMessage(message, input.type as string);
    if (message.role !== "assistant") return [];
    if (this.activeAssistantMessageId) malformed(input.type as string);
    const messageId = this.createId();
    if (!messageId) malformed(input.type as string);
    this.activeAssistantMessageId = messageId;
    return [{ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" }];
  }

  private onMessageUpdate(input: Record<string, unknown>): AdaptedPiEvent[] {
    const message = requireRecord(input.message, input.type as string);
    validateMessage(message, input.type as string);
    if (message.role !== "assistant") malformed(input.type as string);
    const update = requireRecord(input.assistantMessageEvent, input.type as string);
    validateAssistantMessageEvent(update, input.type as string);
    if (update.type !== "text_delta") return [];
    if (!this.activeAssistantMessageId) malformed(input.type as string);
    const delta = update.delta;
    if (typeof delta !== "string") malformed(input.type as string);
    return [{ type: EventType.TEXT_MESSAGE_CONTENT, messageId: this.activeAssistantMessageId, delta }];
  }

  private onMessageEnd(input: Record<string, unknown>): AdaptedPiEvent[] {
    const message = requireRecord(input.message, input.type as string);
    validateMessage(message, input.type as string);
    if (message.role !== "assistant") return [];
    if (!this.activeAssistantMessageId) malformed(input.type as string);
    const messageId = this.activeAssistantMessageId;
    this.activeAssistantMessageId = undefined;
    return [{ type: EventType.TEXT_MESSAGE_END, messageId }];
  }

  private onToolStart(input: Record<string, unknown>): AdaptedPiEvent[] {
    const { toolCallId, toolName } = this.requireToolIdentity(input);
    requireJsonRecord(input.args, input.type as string);
    const delta = serialize(input.args, input.type as string);
    return [
      { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: toolName },
      { type: EventType.TOOL_CALL_ARGS, toolCallId, delta },
      { type: EventType.TOOL_CALL_END, toolCallId },
    ];
  }

  private onToolEnd(input: Record<string, unknown>): AdaptedPiEvent[] {
    const { toolCallId } = this.requireToolIdentity(input);
    validateToolResult(input.result, input.type as string);
    if (typeof input.isError !== "boolean") malformed(input.type as string);
    const messageId = this.createId();
    if (!messageId) malformed(input.type as string);
    return [{
      type: EventType.TOOL_CALL_RESULT,
      toolCallId,
      messageId,
      content: serialize({ result: input.result, isError: input.isError }, input.type as string),
      role: "tool",
    }];
  }

  private requireToolIdentity(input: Record<string, unknown>): { toolCallId: string; toolName: string } {
    if (typeof input.toolCallId !== "string" || !input.toolCallId || typeof input.toolName !== "string" || !input.toolName) {
      malformed(input.type as string);
    }
    return { toolCallId: input.toolCallId as string, toolName: input.toolName as string };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, type: string): Record<string, unknown> {
  if (!isRecord(value)) malformed(type);
  return value;
}

function requireJsonRecord(value: unknown, type: string): Record<string, unknown> {
  const record = requireRecord(value, type);
  serialize(record, type);
  return record;
}

function validateMessage(message: Record<string, unknown>, type: string): void {
  if (message.role === "assistant") {
    if (!Array.isArray(message.content)) malformed(type);
    return;
  }
  if (message.role === "user") {
    if (typeof message.content !== "string" && !Array.isArray(message.content)) malformed(type);
    return;
  }
  if (message.role === "toolResult") {
    if (
      typeof message.toolCallId !== "string"
      || typeof message.toolName !== "string"
      || !Array.isArray(message.content)
      || typeof message.isError !== "boolean"
    ) malformed(type);
    return;
  }
  malformed(type);
}

function validateAssistantMessageEvent(event: Record<string, unknown>, type: string): void {
  if (typeof event.type !== "string") malformed(type);
  switch (event.type) {
    case "start":
      requireAssistantMessage(event.partial, type);
      return;
    case "text_start":
    case "thinking_start":
    case "toolcall_start":
      requireContentIndexAndPartial(event, type);
      return;
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      requireContentIndexAndPartial(event, type);
      if (typeof event.delta !== "string") malformed(type);
      return;
    case "text_end":
    case "thinking_end":
      requireContentIndexAndPartial(event, type);
      if (typeof event.content !== "string") malformed(type);
      return;
    case "toolcall_end":
      requireContentIndexAndPartial(event, type);
      validateToolCall(requireRecord(event.toolCall, type), type);
      return;
    case "done":
      if (!["stop", "length", "toolUse", "deferred"].includes(String(event.reason))) malformed(type);
      requireAssistantMessage(event.message, type);
      return;
    case "error":
      if (!["aborted", "error"].includes(String(event.reason))) malformed(type);
      requireAssistantMessage(event.error, type);
      return;
    default:
      malformed(type);
  }
}

function requireContentIndexAndPartial(event: Record<string, unknown>, type: string): void {
  if (!Number.isInteger(event.contentIndex) || (event.contentIndex as number) < 0) malformed(type);
  requireAssistantMessage(event.partial, type);
}

function requireAssistantMessage(value: unknown, type: string): Record<string, unknown> {
  const message = requireRecord(value, type);
  validateMessage(message, type);
  if (message.role !== "assistant") malformed(type);
  return message;
}

function validateToolCall(toolCall: Record<string, unknown>, type: string): void {
  if (
    toolCall.type !== "toolCall"
    || typeof toolCall.id !== "string"
    || !toolCall.id
    || typeof toolCall.name !== "string"
    || !toolCall.name
  ) malformed(type);
  requireJsonRecord(toolCall.arguments, type);
}

function validateToolResult(value: unknown, type: string): void {
  const result = requireJsonRecord(value, type);
  if (!Array.isArray(result.content) || !("details" in result)) malformed(type);
  for (const item of result.content) {
    const content = requireRecord(item, type);
    if (content.type === "text") {
      if (typeof content.text !== "string") malformed(type);
    } else if (content.type === "image") {
      if (typeof content.data !== "string" || typeof content.mimeType !== "string") malformed(type);
    } else {
      malformed(type);
    }
  }
}

function serialize(value: unknown, type: string): string {
  assertStrictJsonValue(value, type, new WeakSet<object>());
  return JSON.stringify(value);
}

function assertStrictJsonValue(value: unknown, type: string, ancestors: WeakSet<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) malformed(type);
    return;
  }
  if (typeof value !== "object") malformed(type);
  const object = value as object;
  if (ancestors.has(object)) malformed(type);
  ancestors.add(object);
  try {
    if (Array.isArray(value)) {
      for (const item of value) assertStrictJsonValue(item, type, ancestors);
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) malformed(type);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key)) malformed(type);
      assertStrictJsonValue((value as Record<string, unknown>)[key], type, ancestors);
    }
  } finally {
    ancestors.delete(object);
  }
}

function malformed(type: string): never {
  throw new Error(`Malformed Pi event: ${type}`);
}
