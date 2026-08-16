import { createResearchSession } from "./pi/research-session.js";
import type { ResearchClient } from "./research-client.js";

export type ChatEvent = { id: number; type: string; data: Record<string, unknown> };
type SessionLike = {
  prompt(text: string): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
  dispose(): void;
  abort?(): Promise<void> | void;
};

type ChatState = {
  sessionId: string;
  session?: SessionLike;
  unsubscribe?: () => void;
  activeRunId?: string;
  nextEventId: number;
  events: ChatEvent[];
  subscribers: Set<(event: ChatEvent) => void>;
  idempotency: Map<string, { runId: string }>;
  assistantText: Map<string, string>;
  queue: Promise<void>;
  generation: number;
  eventQueue: Promise<void>;
};

export class ChatRegistry {
  private readonly chats = new Map<string, ChatState>();

  constructor(
    private readonly researchClient: ResearchClient,
    private readonly sessionFactory: (chatId: string) => Promise<SessionLike> = (chatId) =>
      createResearchSession({ sessionId: chatId, client: researchClient }) as Promise<SessionLike>,
  ) {}

  addChat(chatId: string, sessionId = chatId): void {
    if (!this.chats.has(chatId)) {
      this.chats.set(chatId, { sessionId, nextEventId: 1, events: [], subscribers: new Set(), idempotency: new Map(), assistantText: new Map(), queue: Promise.resolve(), generation: 0, eventQueue: Promise.resolve() });
    }
  }

  async restore(): Promise<void> {
    for (const chat of await this.researchClient.listChats()) {
      this.addChat(chat.id, chat.pi_session_id);
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
    let result: { status: "accepted" | "replayed"; runId: string };
    let resolve!: () => void;
    const turn = new Promise<void>((r) => { resolve = r; });
    const previousQueue = state.queue;
    state.queue = previousQueue.then(async () => {
      if (state.activeRunId) throw new Error("chat already has an active run");
      const session = await this.getSession(chatId, state);
      const run = await this.researchClient.createRun({ chat_id: chatId, pi_session_id: state.sessionId, model: process.env.IRA_PI_MODEL ?? "configured-model", idempotency_key: idempotencyKey });
      const runId = String(run.id);
      if (run.status === "succeeded" || run.status === "cancelled") {
        result = { status: "replayed", runId };
        return;
      }
      if (run.status === "failed" && run.replayed) throw new Error("run failed and is retryable with a new idempotency key");
      if (run.status === "running" && run.replayed) throw new Error("chat already has an active run; retryable");
      await this.researchClient.appendMessage(chatId, { role: "user", content, idempotency_key: idempotencyKey });
      const generation = state.generation;
      state.activeRunId = runId;
      state.idempotency.set(idempotencyKey, { runId });
      await this.enqueueEmit(chatId, "run.started", { run_id: runId });
      state.assistantText.set(runId, "");
      state.unsubscribe?.();
      state.unsubscribe = session.subscribe((event) => this.handlePiEvent(chatId, event, runId, generation));
      void this.runPrompt(chatId, state, session, content, runId, generation);
      result = { status: "accepted", runId };
    }).finally(resolve);
    await previousQueue;
    await turn;
    return result!;
  }

  async stop(chatId: string): Promise<{ runId: string }> {
    const state = this.requireChat(chatId);
    const runId = state.activeRunId;
    if (!runId) throw new Error("chat has no active run");
    state.generation += 1;
    try { await state.session?.abort?.(); } catch { /* cancellation continues */ }
    let persistenceError: unknown;
    try {
      try { if (typeof this.researchClient.updateRun === "function") await this.researchClient.updateRun(runId, "cancelled"); } catch (error) { persistenceError = error; }
      if (!persistenceError) {
        state.activeRunId = undefined;
        try { await this.enqueueEmit(chatId, "run.cancelled", { run_id: runId }); } catch (error) { persistenceError = error; }
      }
    } finally {
      if (persistenceError) state.activeRunId = runId;
    }
    if (persistenceError) throw persistenceError;
    return { runId };
  }

  private async runPrompt(chatId: string, state: ChatState, session: SessionLike, content: string, runId: string, generation: number) {
    try {
      await session.prompt(content);
      if (state.activeRunId === runId && state.generation === generation) {
        const content = state.assistantText.get(runId) ?? "";
        if (content) await this.researchClient.appendMessage(chatId, { role: "assistant", content });
        await this.enqueueEmit(chatId, "message.completed", { run_id: runId, content });
        await this.enqueueEmit(chatId, "run.completed", { run_id: runId });
        if (typeof this.researchClient.updateRun === "function") await this.researchClient.updateRun(runId, "succeeded");
      }
    } catch (error) {
      if (state.generation === generation && typeof this.researchClient.updateRun === "function") await this.researchClient.updateRun(runId, "failed", { retryable: true });
      if (state.generation === generation) await this.enqueueEmit(chatId, "run.failed", { run_id: runId, message: "research run failed" });
    } finally {
      if (state.activeRunId === runId) state.activeRunId = undefined;
    }
  }

  private async getSession(chatId: string, state: ChatState): Promise<SessionLike> {
    if (state.session) return state.session;
    state.session = await this.sessionFactory(state.sessionId);
    state.unsubscribe = undefined;
    return state.session;
  }

  private handlePiEvent(chatId: string, event: unknown, eventRunId: string, runGeneration: number): void {
    const value = event as { type?: string; assistantMessageEvent?: { type?: string; delta?: string }; toolName?: string };
    const state = this.requireChat(chatId);
    if (!state.activeRunId || state.activeRunId !== eventRunId || runGeneration !== state.generation) return;
    if (value.type === "message_update" && value.assistantMessageEvent?.type === "text_delta") {
      const delta = value.assistantMessageEvent.delta ?? "";
      if (state.activeRunId) state.assistantText.set(state.activeRunId, (state.assistantText.get(state.activeRunId) ?? "") + delta);
      this.enqueueEmit(chatId, "message.delta", { delta });
    } else if (value.type === "tool_execution_start") {
      this.enqueueEmit(chatId, "tool.started", { tool_name: value.toolName ?? "research_tool" });
    } else if (value.type === "tool_execution_end") {
      this.enqueueEmit(chatId, "tool.completed", { tool_name: value.toolName ?? "research_tool" });
    }
  }

  private async emit(chatId: string, type: string, data: Record<string, unknown>): Promise<void> {
    const state = this.requireChat(chatId);
    const persisted = typeof this.researchClient.appendEvent === "function" ? await this.researchClient.appendEvent(chatId, { type, data }) : { id: state.nextEventId++, type, data };
    const event = { id: persisted.id, type: persisted.type, data: persisted.data };
    state.nextEventId = Math.max(state.nextEventId, event.id + 1);
    state.events.push(event);
    if (state.events.length > 1000) state.events.shift();
    for (const subscriber of state.subscribers) subscriber(event);
  }

  private enqueueEmit(chatId: string, type: string, data: Record<string, unknown>): Promise<void> {
    const state = this.requireChat(chatId);
    const operation = state.eventQueue.catch(() => undefined).then(() => this.emit(chatId, type, data));
    state.eventQueue = operation.catch(() => undefined);
    return operation;
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
