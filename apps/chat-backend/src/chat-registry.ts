import { createResearchSession } from "./pi/research-session.js";
import type { ResearchClient } from "./research-client.js";

export type ChatEvent = { id: number; type: string; data: Record<string, unknown> };
type SessionLike = {
  prompt(text: string): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
  dispose(): void;
};

type ChatState = {
  session?: SessionLike;
  unsubscribe?: () => void;
  activeRunId?: string;
  nextEventId: number;
  events: ChatEvent[];
  subscribers: Set<(event: ChatEvent) => void>;
  idempotency: Map<string, { runId: string }>;
  assistantText: Map<string, string>;
};

export class ChatRegistry {
  private readonly chats = new Map<string, ChatState>();

  constructor(
    private readonly researchClient: ResearchClient,
    private readonly sessionFactory: (chatId: string) => Promise<SessionLike> = (chatId) =>
      createResearchSession({ sessionId: chatId, client: researchClient }) as Promise<SessionLike>,
  ) {}

  addChat(chatId: string): void {
    if (!this.chats.has(chatId)) {
      this.chats.set(chatId, { nextEventId: 1, events: [], subscribers: new Set(), idempotency: new Map(), assistantText: new Map() });
    }
  }

  hasChat(chatId: string): boolean {
    return this.chats.has(chatId);
  }

  getEvents(chatId: string, lastEventId?: number): ChatEvent[] {
    const state = this.requireChat(chatId);
    return state.events.filter((event) => lastEventId === undefined || event.id > lastEventId);
  }

  subscribe(chatId: string, listener: (event: ChatEvent) => void): () => void {
    const state = this.requireChat(chatId);
    state.subscribers.add(listener);
    return () => state.subscribers.delete(listener);
  }

  async prompt(chatId: string, content: string, idempotencyKey: string): Promise<{ status: "accepted" | "replayed"; runId: string }> {
    const state = this.requireChat(chatId);
    const previous = state.idempotency.get(idempotencyKey);
    if (previous) return { status: "replayed", runId: previous.runId };
    if (state.activeRunId) throw new Error("chat already has an active run");
    const session = await this.getSession(chatId, state);
    await this.researchClient.appendMessage(chatId, { role: "user", content });
    const run = await this.researchClient.createRun({
      chat_id: chatId,
      pi_session_id: chatId,
      model: process.env.IRA_PI_MODEL ?? "configured-model",
    });
    const runId = String(run.id);
    state.activeRunId = runId;
    state.idempotency.set(idempotencyKey, { runId });
    this.emit(chatId, "run.started", { run_id: runId });
    state.assistantText.set(runId, "");
    void this.runPrompt(chatId, state, session, content, runId);
    return { status: "accepted", runId };
  }

  private async runPrompt(chatId: string, state: ChatState, session: SessionLike, content: string, runId: string) {
    try {
      await session.prompt(content);
      if (state.activeRunId === runId) {
        const content = state.assistantText.get(runId) ?? "";
        if (content) await this.researchClient.appendMessage(chatId, { role: "assistant", content });
        this.emit(chatId, "message.completed", { run_id: runId, content });
        this.emit(chatId, "run.completed", { run_id: runId });
      }
    } catch (error) {
      this.emit(chatId, "run.failed", { run_id: runId, message: "research run failed" });
    } finally {
      if (state.activeRunId === runId) state.activeRunId = undefined;
    }
  }

  private async getSession(chatId: string, state: ChatState): Promise<SessionLike> {
    if (state.session) return state.session;
    state.session = await this.sessionFactory(chatId);
    state.unsubscribe = state.session.subscribe((event) => this.handlePiEvent(chatId, event));
    return state.session;
  }

  private handlePiEvent(chatId: string, event: unknown): void {
    const value = event as { type?: string; assistantMessageEvent?: { type?: string; delta?: string }; toolName?: string };
    if (value.type === "message_update" && value.assistantMessageEvent?.type === "text_delta") {
      const delta = value.assistantMessageEvent.delta ?? "";
      const state = this.requireChat(chatId);
      if (state.activeRunId) state.assistantText.set(state.activeRunId, (state.assistantText.get(state.activeRunId) ?? "") + delta);
      this.emit(chatId, "message.delta", { delta });
    } else if (value.type === "tool_execution_start") {
      this.emit(chatId, "tool.started", { tool_name: value.toolName ?? "research_tool" });
    } else if (value.type === "tool_execution_end") {
      this.emit(chatId, "tool.completed", { tool_name: value.toolName ?? "research_tool" });
    }
  }

  private emit(chatId: string, type: string, data: Record<string, unknown>): void {
    const state = this.requireChat(chatId);
    const event = { id: state.nextEventId++, type, data };
    state.events.push(event);
    if (state.events.length > 1000) state.events.shift();
    for (const subscriber of state.subscribers) subscriber(event);
  }

  private requireChat(chatId: string): ChatState {
    const state = this.chats.get(chatId);
    if (!state) throw new Error("chat not found");
    return state;
  }

  async dispose(): Promise<void> {
    for (const state of this.chats.values()) {
      state.unsubscribe?.();
      state.session?.dispose();
    }
    this.chats.clear();
  }
}
