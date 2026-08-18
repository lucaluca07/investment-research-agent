import { PersistentResearchAgent } from "./persistent-research-agent.js";
import Fastify from "fastify";

export function awaitDrain(raw: any, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (ok: boolean) => { raw.off?.("drain", onDrain); raw.off?.("close", onClose); signal.removeEventListener("abort", onAbort); resolve(ok); };
    const onDrain = () => done(true); const onClose = () => done(false); const onAbort = () => done(false);
    raw.once?.("drain", onDrain); raw.once?.("close", onClose); signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function writeFrame(raw: any, frame: string, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  if (raw.write(frame)) return true;
  return await awaitDrain(raw, signal);
}

type SseEvent = { id?: number; type?: string; data?: unknown };

/** Parse complete SSE records while retaining an incomplete trailing record. */
export function takeSseEvents(buffer: string): { events: SseEvent[]; remainder: string } {
  const records = buffer.split(/\r?\n\r?\n/);
  const remainder = records.pop() ?? "";
  const events = records.map((record) => {
    const fields: Record<string, string[]> = {};
    for (const line of record.split(/\r?\n/)) {
      const match = /^(id|event|data): ?(.*)$/.exec(line);
      if (match) (fields[match[1]] ??= []).push(match[2]);
    }
    const text = (fields.data ?? []).join("\n");
    let data: unknown = text;
    if (text) { try { data = JSON.parse(text); } catch { /* upstream payload is allowed to be text */ } }
    const parsedId = Number((fields.id ?? [""])[0]);
    return { id: Number.isSafeInteger(parsedId) && parsedId >= 0 ? parsedId : undefined, type: (fields.event ?? [undefined])[0], data };
  });
  return { events, remainder };
}

function runErrorFrame(sequence: number, message: string): string {
  return `id: ${Math.max(1, sequence + 1)}\nevent: RUN_ERROR\ndata: ${JSON.stringify({ type: "RUN_ERROR", message })}\n\n`;
}

type RuntimeInput = Record<string, any> & { threadId?: string; thread_id?: string };
type RuntimeDeps = {
  researchUrl: string;
  input: RuntimeInput;
  headers: Record<string, string>;
  raw: any;
  signal: AbortSignal;
  fetcher?: typeof fetch;
};

/** Runs one durable research run and writes its replay stream to the supplied raw response. */
export async function streamAgentRun({ researchUrl, input, headers, raw, signal, fetcher = fetch }: RuntimeDeps): Promise<void> {
  const threadId = input.threadId ?? input.thread_id;
  if (!threadId) throw new Error("threadId is required");
  const after = Number(input.after ?? headers["last-event-id"] ?? 0);
  const runUrl = `${researchUrl}/v1/threads/${encodeURIComponent(threadId)}/runs${after > 0 ? `?after=${encodeURIComponent(String(after))}` : ""}`;
  const createResponse = await fetcher(runUrl, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ ...input, idempotency_key: input.idempotency_key ?? input.runId ?? crypto.randomUUID() }), signal,
  });
  if (!createResponse.ok) throw Object.assign(new Error(await createResponse.text()), { statusCode: createResponse.status });
  if (createResponse.headers.get("content-type")?.includes("text/event-stream")) {
    if (!createResponse.body) throw new Error("streaming run has no response body");
    const reader = createResponse.body.getReader();
    while (!signal.aborted) {
      const next = await reader.read();
      if (next.done) break;
      if (!(await writeFrame(raw, new TextDecoder().decode(next.value, { stream: true }), signal))) return;
    }
    raw.end?.();
    return;
  }
  // The create response may report the run's latest persisted sequence.  It is
  // not a replay cursor: using it here would turn an idempotent retry into an
  // empty stream.  Only the caller's explicit cursor advances the replay.
  await createResponse.json();
  let cursor = after;
  const eventsResponse = await fetcher(`${researchUrl}/v1/threads/${encodeURIComponent(threadId)}/events?after=${cursor}`, {
    headers: { ...headers, accept: "text/event-stream" }, signal,
  });
  if (!eventsResponse.ok) throw new Error(`event replay failed: ${eventsResponse.status}`);
  if (!eventsResponse.body) throw new Error("event stream has no response body");
  const reader = eventsResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!signal.aborted) {
    const next = await reader.read();
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    const parsed = takeSseEvents(buffer); buffer = parsed.remainder;
    for (const event of parsed.events) {
      const sequence = event.id ?? cursor + 1;
      if (sequence <= cursor) continue;
      cursor = sequence;
      const type = event.type ?? "AGUI_EVENT";
      const frame = `id: ${sequence}\nevent: ${type}\ndata: ${JSON.stringify(event.data ?? {})}\n\n`;
      if (!(await writeFrame(raw, frame, signal))) return;
      if (type === "RUN_FINISHED" || type === "RUN_ERROR") { raw.end?.(); return; }
    }
  }
  if (!signal.aborted && buffer.trim()) {
    const parsed = takeSseEvents(`${buffer}\n\n`);
    for (const event of parsed.events) {
      const sequence = event.id ?? cursor + 1;
      if (sequence <= cursor) continue;
      cursor = sequence;
      const type = event.type ?? "AGUI_EVENT";
      if (!(await writeFrame(raw, `id: ${sequence}\nevent: ${type}\ndata: ${JSON.stringify(event.data ?? {})}\n\n`, signal))) return;
      if (type === "RUN_FINISHED" || type === "RUN_ERROR") { raw.end?.(); return; }
    }
  }
  if (!signal.aborted && await writeFrame(raw, runErrorFrame(cursor, "event stream closed before a terminal event"), signal)) raw.end?.();
}

export function registerResearchRuntime(app: any, options: { researchUrl?: string } = {}): void {
  const researchUrl = options.researchUrl ?? process.env.IRA_RESEARCH_SERVICE_URL ?? "http://127.0.0.1:8020";
  const makeAgent = (threadId?: string, headers?: Record<string, string>) => new PersistentResearchAgent({ baseUrl: researchUrl, threadId, headers });
  app.get("/info", async () => ({ agents: [{ name: "research-agent", description: "Durable investment research agent", capabilities: await makeAgent().getCapabilities() }] }));
  app.post("/agent/research-agent/run", async (request: any, reply: any) => {
    const body = request.body ?? {}; const input = { ...body, threadId: body.threadId ?? body.thread_id };
    if (!input.threadId) return reply.code(422).send({ detail: "threadId is required" });
    const headers = Object.fromEntries(Object.entries(request.headers ?? {}).filter(([key]) => key === "authorization" || key === "last-event-id" || key.startsWith("x-ira-")) as [string, string][]);
    reply.hijack(); reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const abort = new AbortController();
    // `IncomingMessage#close` fires after a normal request body completes; only
    // abort on an actual client-side abort, or when the response stream closes
    // before it has ended.
    const onRequestAbort = () => abort.abort();
    const onResponseClose = () => { if (!reply.raw.writableEnded) abort.abort(); };
    request.raw.on("aborted", onRequestAbort);
    reply.raw.on("close", onResponseClose);
    try { await streamAgentRun({ researchUrl, input, headers, raw: reply.raw, signal: abort.signal });
    } catch (error: any) {
      if (!abort.signal.aborted) {
        const message = error instanceof Error ? error.message : "run polling failed";
        await writeFrame(reply.raw, runErrorFrame(Number(input.after ?? headers["last-event-id"] ?? 0), message), abort.signal);
      }
    } finally {
      request.raw.off?.("aborted", onRequestAbort);
      reply.raw.off?.("close", onResponseClose);
      if (!reply.raw.writableEnded) reply.raw.end();
    }
  });
}

export function createResearchRuntime(options: { researchUrl?: string } = {}) {
  return { register(app: any) { registerResearchRuntime(app, options); } };
}

export async function startServer(): Promise<void> {
  const app = Fastify({ logger: false });
  app.get("/health", async () => ({ ok: true }));
  registerResearchRuntime(app, { researchUrl: process.env.IRA_RESEARCH_SERVICE_URL });
  await app.listen({ host: "127.0.0.1", port: Number(process.env.PORT ?? 8030) });
}

if (import.meta.url === `file://${process.argv[1]}`) void startServer();
