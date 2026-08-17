export type CompanySnapshot = {
  company_name: string;
  ticker: "300476.SZ";
  as_of_date: string;
  metrics: Record<string, number | string | null>;
  citations: Array<{
    document_id: string;
    title: string;
    published_at: string;
    locator: string;
  }>;
};

export type SaveResearchNoteRequest = {
  run_id: string;
  idempotency_key: string;
  title: string;
  body: string;
  citation_ids: string[];
};
export type Chat = { id: string; pi_session_id: string };
export type ChatMessage = { id: string; chat_id: string; role: "user" | "assistant" | "tool"; content: string; created_at: string };
export type ChatHistory = { messages: ChatMessage[] };
export type ResearchRun = { id: string; chat_id: string; pi_session_id: string; model: string; status: "running" | "succeeded" | "failed" | "cancelled"; error: Record<string, unknown> | null; created_at: string; replayed?: boolean };
export type PersistedChatEvent = { id: number; type: string; data: Record<string, unknown> };
export type AguiThread = { id: string; title: string; title_source: string; title_locked: boolean; created_at: string };
export type AguiRun = { id: string; thread_id: string; idempotency_key: string; status: "pending"|"running"|"completed"|"interrupted"|"failed"|"cancelled"; model: string|null; replayed?: boolean };
export type AguiEvent = { thread_id: string; sequence: number; run_id: string; type: string; data: Record<string, unknown> };
export type CreateRunRequest = { input: unknown; idempotency_key: string; model?: string };
export type CreateRunResult = { run: AguiRun; replayed: boolean; last_event_seq: number };
export type ThreadState = { thread: AguiThread; last_event_seq: number; runs: AguiRun[] };

export type ResearchClientOptions = {
  fetch?: typeof globalThis.fetch;
};

export class ResearchClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ResearchClientError";
  }
}

export class ResearchClient {
  private readonly baseUrl: URL;
  private readonly requestFetch: typeof globalThis.fetch;

  constructor(baseUrl: string, options: ResearchClientOptions = {}) {
    const parsed = new URL(baseUrl);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
    if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
      throw new Error("Research service base URL must be loopback");
    }
    this.baseUrl = new URL(parsed.toString().endsWith("/") ? parsed : `${parsed}/`);
    this.requestFetch = options.fetch ?? globalThis.fetch;
  }

  async createRun(request: { chat_id: string; pi_session_id: string; model: string; idempotency_key: string }): Promise<ResearchRun> {
    return parseRun(await this.post("v1/research-runs", request));
  }
  async createThread(title = "", id?: string): Promise<AguiThread> { return parseThread(await this.post("v1/threads", { ...(id ? { id } : {}), title })); }
  async listThreads(): Promise<AguiThread[]> { const v=await this.request("GET", "v1/threads"); if(!Array.isArray(v)) throw new ResearchClientError("invalid threads response",200,v); return v.map(parseThread); }
  async createAguiRun(thread_id: string, input: unknown, idempotency_key: string, model?: string): Promise<CreateRunResult> { return parseCreateRunResult(await this.post(`v1/threads/${encodeURIComponent(thread_id)}/runs`, { input, idempotency_key, model })); }
  async appendAguiEvents(thread_id: string, run_id: string, events: Array<{ type: string; data: Record<string, unknown> }>): Promise<{ events: AguiEvent[] }> { const v=await this.post(`v1/threads/${encodeURIComponent(thread_id)}/events:batch`, { run_id, events }); if(!isObject(v)||!Array.isArray(v.events)) throw new ResearchClientError("invalid AG-UI events response",200,v); return {events: validateSequences(v.events.map(parseAguiEvent))}; }
  async listAguiEvents(thread_id: string, after = 0): Promise<AguiEvent[]> { const v=await this.request("GET", `v1/threads/${encodeURIComponent(thread_id)}/events?after=${after}`); if(!Array.isArray(v)) throw new ResearchClientError("invalid AG-UI events response",200,v); return validateSequences(v.map(parseAguiEvent)); }
  async getAguiState(thread_id: string): Promise<ThreadState> { return parseThreadState(await this.request("GET", `v1/threads/${encodeURIComponent(thread_id)}/state`)); }
  async transitionAguiRun(run_id: string, status: AguiRun["status"], error?: Record<string, unknown>, emit_event = true): Promise<AguiRun> { return parseAguiRun(await this.post(`v1/runs/${encodeURIComponent(run_id)}/transition`, { status, error, emit_event })); }

  async queryCompanySnapshot(ticker: "300476.SZ"): Promise<CompanySnapshot> {
    return this.post("v1/tools/query-company-snapshot", { ticker }) as Promise<CompanySnapshot>;
  }

  async saveResearchNote(request: SaveResearchNoteRequest): Promise<{ note_id: string; citation_ids: string[] }> {
    return this.post("v1/tools/save-research-note", request) as Promise<{ note_id: string; citation_ids: string[] }>;
  }

  async getChatHistory(chat_id: string): Promise<ChatHistory> {
    const value = await this.request("GET", `v1/chats/${encodeURIComponent(chat_id)}/messages`); if (!isObject(value) || !Array.isArray(value.messages)) throw new ResearchClientError("invalid chat history response", 200, value); return value as unknown as ChatHistory;
  }

  async createChat(chat_id?: string): Promise<Chat> {
    return parseChat(await this.post("v1/chats", chat_id ? { chat_id } : {}));
  }

  async listChats(): Promise<Chat[]> { const value = await this.request("GET", "v1/chats"); if (!Array.isArray(value)) throw new ResearchClientError("invalid chats response", 200, value); return value.map(parseChat); }
  async getChat(chat_id: string): Promise<Chat> { return parseChat(await this.request("GET", `v1/chats/${encodeURIComponent(chat_id)}`)); }
  async listEvents(chat_id: string, afterId = 0): Promise<PersistedChatEvent[]> { const value = await this.request("GET", `v1/chats/${encodeURIComponent(chat_id)}/events?after=${afterId}`); if (!Array.isArray(value)) throw new ResearchClientError("invalid events response", 200, value); return value.map(parseEvent); }
  async appendEvent(chat_id: string, event: { type: string; data: Record<string, unknown> }): Promise<PersistedChatEvent> { return parseEvent(await this.post(`v1/chats/${encodeURIComponent(chat_id)}/events`, event)); }
  async updateRun(run_id: string, status: ResearchRun["status"], error?: Record<string, unknown>): Promise<void> {
    await this.request("PATCH", `v1/research-runs/${encodeURIComponent(run_id)}`, { status, error });
  }
  async getRun(run_id: string): Promise<ResearchRun> { return parseRun(await this.request("GET", `v1/research-runs/${encodeURIComponent(run_id)}`)); }

  async appendMessage(chat_id: string, request: { role: "user" | "assistant" | "tool"; content: string; idempotency_key?: string }): Promise<ChatMessage> {
    const value = await this.post(`v1/chats/${encodeURIComponent(chat_id)}/messages`, request); if (!isObject(value) || typeof value.id !== "string" || typeof value.chat_id !== "string" || !["user", "assistant", "tool"].includes(String(value.role)) || typeof value.content !== "string") throw new ResearchClientError("invalid message response", 200, value); return value as unknown as ChatMessage;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    return this.request("POST", path, body);
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.requestFetch(new URL(path, this.baseUrl), {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let payload: unknown = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = text;
    }
    if (!response.ok) {
      const message = typeof payload === "object" && payload !== null && "detail" in payload
        ? String((payload as { detail: unknown }).detail)
        : typeof payload === "string" ? payload : "request failed";
      throw new ResearchClientError(`Research service request failed: ${message}`, response.status, payload);
    }
    return payload as Record<string, unknown>;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
function parseChat(value: unknown): Chat { if (!isObject(value) || typeof value.id !== "string" || typeof value.pi_session_id !== "string") throw new ResearchClientError("invalid chat response", 200, value); return value as unknown as Chat; }
function parseRun(value: unknown): ResearchRun { const statuses = ["running", "succeeded", "failed", "cancelled"]; if (!isObject(value) || typeof value.id !== "string" || typeof value.chat_id !== "string" || typeof value.pi_session_id !== "string" || typeof value.model !== "string" || typeof value.created_at !== "string" || !statuses.includes(String(value.status)) || !("error" in value) || (value.error !== null && !isObject(value.error))) throw new ResearchClientError("invalid run response", 200, value); return value as unknown as ResearchRun; }
function parseEvent(value: unknown): PersistedChatEvent { if (!isObject(value) || typeof value.id !== "number" || typeof value.type !== "string" || !isObject(value.data)) throw new ResearchClientError("invalid event response", 200, value); return value as unknown as PersistedChatEvent; }
function parseCreateRunResult(value: unknown): CreateRunResult { if (!isObject(value) || typeof value.replayed !== "boolean" || typeof value.last_event_seq !== "number" || !Number.isInteger(value.last_event_seq) || value.last_event_seq < 0) throw new ResearchClientError("invalid AG-UI run response", 200, value); return {run:parseAguiRun(value.run), replayed:value.replayed, last_event_seq:value.last_event_seq}; }
function parseThreadState(value: unknown): ThreadState { if (!isObject(value) || typeof value.last_event_seq !== "number" || !Number.isInteger(value.last_event_seq) || value.last_event_seq < 0 || !Array.isArray(value.runs)) throw new ResearchClientError("invalid AG-UI state response", 200, value); return {thread:parseThread(value.thread),last_event_seq:value.last_event_seq,runs:value.runs.map(parseAguiRun)}; }
function parseThread(value: unknown): AguiThread { if(!isObject(value)||typeof value.id!=="string"||typeof value.title!=="string"||typeof value.title_source!=="string"||typeof value.title_locked!=="boolean"||typeof value.created_at!=="string") throw new ResearchClientError("invalid thread response",200,value); return value as unknown as AguiThread; }
function parseAguiRun(value: unknown): AguiRun { const s=["pending","running","completed","interrupted","failed","cancelled"]; if(!isObject(value)||typeof value.id!=="string"||typeof value.thread_id!=="string"||typeof value.idempotency_key!=="string"||!s.includes(String(value.status))||(value.model!==null&&typeof value.model!=="string")) throw new ResearchClientError("invalid AG-UI run response",200,value); return value as unknown as AguiRun; }
function parseAguiEvent(value: unknown): AguiEvent { if(!isObject(value)||typeof value.thread_id!=="string"||typeof value.sequence!=="number"||!Number.isInteger(value.sequence)||value.sequence<0||typeof value.run_id!=="string"||typeof value.type!=="string"||value.type.length===0||!isObject(value.data)) throw new ResearchClientError("invalid AG-UI event response",200,value); return value as unknown as AguiEvent; }
function validateSequences(events: AguiEvent[]): AguiEvent[] { for(let i=1;i<events.length;i++) if(events[i].sequence!==events[i-1].sequence+1) throw new ResearchClientError("non-contiguous AG-UI event sequence",200,events); return events; }
