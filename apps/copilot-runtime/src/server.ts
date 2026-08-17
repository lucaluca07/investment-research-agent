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
  const createResponse = await fetcher(`${researchUrl}/v1/threads/${encodeURIComponent(threadId)}/runs`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(input), signal,
  });
  if (!createResponse.ok) throw Object.assign(new Error(await createResponse.text()), { statusCode: createResponse.status });
  const created = await createResponse.json() as { run_id?: string; runId?: string; last_event_seq?: number; lastEventSeq?: number };
  let cursor = Number(input.after ?? created.last_event_seq ?? created.lastEventSeq ?? 0);
  const maxPolls = Number(process.env.IRA_RUNTIME_MAX_POLLS ?? 120);
  for (let attempt = 0; attempt < maxPolls && !signal.aborted; attempt++) {
    const eventsResponse = await fetcher(`${researchUrl}/v1/threads/${encodeURIComponent(threadId)}/events?after=${cursor}`, { headers, signal });
    if (!eventsResponse.ok) throw new Error(`event replay failed: ${eventsResponse.status}`);
    const events = await eventsResponse.json() as Array<{ sequence?: number; type?: string; data?: unknown }>;
    for (const item of events) {
      const sequence = Number(item.sequence ?? ++cursor); if (sequence <= cursor && sequence !== 0) continue; cursor = sequence;
      const event = (item.data ?? item) as { type?: string }; const type = item.type ?? event.type ?? "AGUI_EVENT";
      const frame = `id: ${sequence}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
      if (!(await writeFrame(raw, frame, signal))) return;
      if (type === "RUN_FINISHED" || type === "RUN_ERROR") { raw.end?.(); return; }
    }
    if (!events.length) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!signal.aborted) {
    const frame = `event: RUN_ERROR\ndata: ${JSON.stringify({ type: "RUN_ERROR", message: "run polling timed out" })}\n\n`;
    if (await writeFrame(raw, frame, signal)) raw.end?.();
  }
}

export function registerResearchRuntime(app: any, options: { researchUrl?: string } = {}): void {
  const researchUrl = options.researchUrl ?? process.env.IRA_RESEARCH_SERVICE_URL ?? "http://127.0.0.1:8020";
  const makeAgent = (threadId?: string, headers?: Record<string, string>) => new PersistentResearchAgent({ baseUrl: researchUrl, threadId, headers });
  app.get("/info", async () => ({ agents: [{ name: "research-agent", description: "Durable investment research agent", capabilities: await makeAgent().getCapabilities() }] }));
  app.post("/agent/research-agent/run", async (request: any, reply: any) => {
    const body = request.body ?? {}; const input = { ...body, threadId: body.threadId ?? body.thread_id };
    if (!input.threadId) return reply.code(422).send({ detail: "threadId is required" });
    const headers = Object.fromEntries(Object.entries(request.headers ?? {}).filter(([key]) => key === "authorization" || key.startsWith("x-ira-")) as [string, string][]);
    reply.hijack(); reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const abort = new AbortController(); const onRequestClose = () => abort.abort(); request.raw.on("close", onRequestClose);
    try { await streamAgentRun({ researchUrl, input, headers, raw: reply.raw, signal: abort.signal });
    } catch (error: any) {
      if (!abort.signal.aborted) {
        const message = error instanceof Error ? error.message : "run polling failed";
        await writeFrame(reply.raw, `event: RUN_ERROR\ndata: ${JSON.stringify({ type: "RUN_ERROR", message })}\n\n`, abort.signal);
      }
    } finally { request.raw.off?.("close", onRequestClose); if (!reply.raw.writableEnded) reply.raw.end(); }
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
