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

export type ResearchClientOptions = {
  fetch?: typeof globalThis.fetch;
};

export class ResearchClient {
  private readonly baseUrl: URL;
  private readonly requestFetch: typeof globalThis.fetch;

  constructor(baseUrl: string, options: ResearchClientOptions = {}) {
    const parsed = new URL(baseUrl);
    if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
      throw new Error("Research service base URL must be loopback");
    }
    this.baseUrl = new URL(parsed.toString().endsWith("/") ? parsed : `${parsed}/`);
    this.requestFetch = options.fetch ?? globalThis.fetch;
  }

  async createRun(request: { chat_id: string; pi_session_id: string; model: string }): Promise<Record<string, unknown>> {
    return this.post("v1/research-runs", request);
  }

  async queryCompanySnapshot(ticker: "300476.SZ"): Promise<CompanySnapshot> {
    return this.post("v1/tools/query-company-snapshot", { ticker }) as Promise<CompanySnapshot>;
  }

  async saveResearchNote(request: SaveResearchNoteRequest): Promise<Record<string, unknown>> {
    return this.post("v1/tools/save-research-note", request);
  }

  async createChat(chat_id: string): Promise<Record<string, unknown>> {
    return this.post("v1/chats", { chat_id });
  }

  async updatePiSession(chat_id: string, pi_session_id: string): Promise<Record<string, unknown>> {
    return this.request("PATCH", `v1/chats/${encodeURIComponent(chat_id)}/pi-session`, { pi_session_id });
  }

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    return this.request("POST", path, body);
  }

  private async request(method: string, path: string, body: unknown): Promise<Record<string, unknown>> {
    const response = await this.requestFetch(new URL(path, this.baseUrl), {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`Research service request failed: ${response.status}`);
    }
    return payload as Record<string, unknown>;
  }
}
