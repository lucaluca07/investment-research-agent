import { AbstractAgent } from "@ag-ui/client";
import type { BaseEvent, RunAgentInput, AgentCapabilities } from "@ag-ui/core";
import { Observable } from "rxjs";

export type ResearchAgentOptions = { baseUrl: string; fetch?: typeof fetch; headers?: Record<string, string> };

function headersFor(input: RequestInit, extra: Record<string, string> = {}) {
  const source = input.headers instanceof Headers ? Object.fromEntries(input.headers.entries()) : (input.headers as Record<string, string> | undefined) ?? {};
  return Object.fromEntries(Object.entries({ ...source, ...extra }).filter(([key]) => key.toLowerCase() === "authorization" || key.toLowerCase().startsWith("x-ira-")));
}

export class PersistentResearchAgent extends AbstractAgent {
  readonly description = "Durable investment research agent";
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly extraHeaders: Record<string, string>;
  private activeAbort?: AbortController;
  private cursor = 0;
  private activeRunId?: string;

  constructor(options: ResearchAgentOptions & { threadId?: string; initialState?: Record<string, unknown> }) {
    super({ agentId: "research-agent", description: "Durable investment research agent", threadId: options.threadId, initialState: options.initialState ?? {} });
    const url = new URL(options.baseUrl);
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error("research runtime must use loopback Fastify URL");
    this.baseUrl = url.toString().replace(/\/$/, ""); this.doFetch = options.fetch ?? fetch; this.extraHeaders = options.headers ?? {};
  }

  async getCapabilities(): Promise<AgentCapabilities> {
    return { identity: { name: "research-agent", type: "research", description: this.description }, transport: { streaming: true, resumable: true }, state: { snapshots: true, persistentState: true }, humanInTheLoop: { supported: true, approvals: true, interrupts: true } } as AgentCapabilities;
  }

  run(input: RunAgentInput): Observable<BaseEvent> { this.activeRunId = input.runId; return this.stream(`/v1/threads/${encodeURIComponent(input.threadId)}/runs`, input, "POST"); }

  protected connect(input: RunAgentInput): Observable<BaseEvent> {
    const after = this.cursor;
    return new Observable((subscriber) => {
      const abort = new AbortController(); this.activeAbort = abort;
      void (async () => {
        try {
          const state = await this.request(`/v1/threads/${encodeURIComponent(input.threadId)}/state`, { signal: abort.signal });
          if (state && typeof state === "object" && "state" in state) this.setState(structuredClone((state as { state: Record<string, unknown> }).state));
          const events = await this.request(`/v1/threads/${encodeURIComponent(input.threadId)}/events?after=${after}`, { signal: abort.signal });
          for (const event of Array.isArray(events) ? events : []) { const sequence = Number((event as { sequence?: number }).sequence ?? 0); if (sequence <= this.cursor) continue; this.cursor = sequence; subscriber.next((event as { data?: BaseEvent }).data ?? event as BaseEvent); }
          subscriber.complete();
        } catch (error) { if (!abort.signal.aborted) subscriber.error(error); }
      })(); return () => abort.abort();
    });
  }

  abortRun(): void { this.activeAbort?.abort(); if (this.activeRunId) void this.request(`/v1/runs/${encodeURIComponent(this.activeRunId)}/transition`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "cancelled" }) }).catch(() => undefined); }

  private stream(path: string, input: RunAgentInput, method: string): Observable<BaseEvent> {
    return new Observable((subscriber) => { const abort = new AbortController(); this.activeAbort = abort; void (async () => { try { const response = await this.doFetch(this.baseUrl + path, { method, signal: abort.signal, headers: { "content-type": "application/json", ...this.extraHeaders }, body: JSON.stringify({ ...input, messages: structuredClone(input.messages) }) }); if (!response.ok || !response.body) throw new Error(`research run failed: ${response.status}`); const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ""; while (true) { const next = await reader.read(); if (next.done) break; buffer += decoder.decode(next.value, { stream: true }); const chunks = buffer.split("\n\n"); buffer = chunks.pop() ?? ""; for (const chunk of chunks) { const line = chunk.split("\n").find((value) => value.startsWith("data:")); if (!line) continue; const event = JSON.parse(line.slice(5).trim()) as BaseEvent & { sequence?: number; data?: BaseEvent }; const sequence = event.sequence; if (typeof sequence === "number" && sequence <= this.cursor) continue; if (typeof sequence === "number") this.cursor = sequence; subscriber.next((event.data ?? event) as BaseEvent); } } subscriber.complete(); } catch (error) { if (!abort.signal.aborted) subscriber.error(error); } })(); return () => abort.abort(); });
  }

  private async request(path: string, init: RequestInit = {}): Promise<any> { const response = await this.doFetch(this.baseUrl + path, { ...init, headers: headersFor(init, this.extraHeaders) }); if (!response.ok) throw new Error(`research runtime request failed: ${response.status}`); return response.status === 204 ? undefined : response.json(); }
}

export function createResearchAgent(options: ResearchAgentOptions & { threadId?: string }): PersistentResearchAgent { return new PersistentResearchAgent(options); }
