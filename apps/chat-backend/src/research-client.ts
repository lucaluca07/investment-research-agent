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
export type ResearchRun = { id: string; chat_id: string; pi_session_id: string; model: string; status: "running" | "succeeded" | "failed" | "cancelled"; error: Record<string, unknown> | null; created_at: string };
export type PersistedChatEvent = { id: number; type: string; data: Record<string, unknown> };

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
function parseRun(value: unknown): ResearchRun { if (!isObject(value) || typeof value.id !== "string" || typeof value.chat_id !== "string" || typeof value.status !== "string") throw new ResearchClientError("invalid run response", 200, value); return value as unknown as ResearchRun; }
function parseEvent(value: unknown): PersistedChatEvent { if (!isObject(value) || typeof value.id !== "number" || typeof value.type !== "string" || !isObject(value.data)) throw new ResearchClientError("invalid event response", 200, value); return value as unknown as PersistedChatEvent; }
