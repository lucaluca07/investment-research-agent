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

  async createRun(request: { chat_id: string; pi_session_id: string; model: string }): Promise<ResearchRun> {
    return this.post("v1/research-runs", request) as Promise<ResearchRun>;
  }

  async queryCompanySnapshot(ticker: "300476.SZ"): Promise<CompanySnapshot> {
    return this.post("v1/tools/query-company-snapshot", { ticker }) as Promise<CompanySnapshot>;
  }

  async saveResearchNote(request: SaveResearchNoteRequest): Promise<{ note_id: string; citation_ids: string[] }> {
    return this.post("v1/tools/save-research-note", request) as Promise<{ note_id: string; citation_ids: string[] }>;
  }

  async getChatHistory(chat_id: string): Promise<ChatHistory> {
    return this.request("GET", `v1/chats/${encodeURIComponent(chat_id)}/messages`) as Promise<ChatHistory>;
  }

  async createChat(chat_id?: string): Promise<Chat> {
    return this.post("v1/chats", chat_id ? { chat_id } : {}) as Promise<Chat>;
  }

  async listChats(): Promise<Chat[]> { return this.request("GET", "v1/chats") as unknown as Promise<Chat[]>; }
  async getChat(chat_id: string): Promise<Chat> { return this.request("GET", `v1/chats/${encodeURIComponent(chat_id)}`) as Promise<Chat>; }
  async updateRun(run_id: string, status: ResearchRun["status"], error?: Record<string, unknown>): Promise<void> {
    await this.request("PATCH", `v1/research-runs/${encodeURIComponent(run_id)}`, { status, error });
  }

  async appendMessage(chat_id: string, request: { role: "user" | "assistant" | "tool"; content: string; idempotency_key?: string }): Promise<ChatMessage> {
    return this.post(`v1/chats/${encodeURIComponent(chat_id)}/messages`, request) as Promise<ChatMessage>;
  }

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    return this.request("POST", path, body);
  }

  private async request(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
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
