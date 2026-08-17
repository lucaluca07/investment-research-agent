import type { FastifyInstance } from "fastify";
import { RunController } from "../ag-ui/run-controller.js";
import type { ResearchClient } from "../research-client.js";

export async function registerAgentRoutes(app: FastifyInstance, client: ResearchClient, controller: RunController): Promise<void> {
  const streamRun = async (request: any, reply: any) => {
    const threadId = (request.params as { threadId: string }).threadId;
    const body = (request.body ?? {}) as { input?: unknown; idempotency_key?: string; model?: string };
    if (!body.idempotency_key?.trim()) return reply.code(422).send({ detail: "idempotency_key is required" });
    try {
      const result = await controller.start(threadId, body.input ?? "", body.idempotency_key, body.model);
      reply.hijack(); reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const seen = new Set<number>();
      const write = (event: any) => { const seq = event.sequence; if (typeof seq === "number" && seen.has(seq)) return; if (typeof seq === "number") seen.add(seq); reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data ?? event)}\n\n`); };
      let replaying = true; const pending: unknown[] = [];
      const unsubscribe = controller.subscribe(threadId, (event) => { if (replaying) pending.push(event); else write(event); });
      for (const event of await client.listAguiEvents(threadId, 0)) write(event);
      replaying = false; for (const event of pending) write(event);
      request.raw.on("close", unsubscribe);
      await result.done;
      unsubscribe(); reply.raw.end();
    } catch (error) {
      if (!reply.sent) return reply.code(error instanceof Error && error.message.includes("active") ? 409 : 500).send({ detail: error instanceof Error ? error.message : "run failed" });
    }
  };
  app.post("/v1/threads/:threadId/runs", streamRun);
  app.post("/v1/threads/:threadId/runs/stream", streamRun);
  app.get("/v1/threads/:threadId/events", async (request) => { const q = request.query as { after?: string }; return client.listAguiEvents((request.params as { threadId: string }).threadId, Number(q.after ?? 0)); });
  app.get("/v1/threads/:threadId/state", async (request) => client.getAguiState((request.params as { threadId: string }).threadId));
  app.post("/v1/threads/:threadId/stop", async (request, reply) => { try { return await controller.stop((request.params as { threadId: string }).threadId); } catch (error) { return reply.code(409).send({ detail: error instanceof Error ? error.message : "cannot stop run" }); } });
  app.post("/v1/threads/:threadId/interrupts/:interruptId/resume", async (request, reply) => {
    const { threadId, interruptId } = request.params as { threadId: string; interruptId: string };
    const body = (request.body ?? {}) as { status?: "resolved" | "cancelled"; payload?: { approved?: unknown } };
    if ((body.status !== "resolved" && body.status !== "cancelled") || typeof body.payload?.approved !== "boolean") return reply.code(422).send({ detail: "status and payload.approved are required" });
    try {
      const open = await client.listOpenInterrupts(threadId);
      if (open.length !== 1 || open[0]?.interrupt_id !== interruptId) return reply.code(409).send({ detail: "resume request must cover every open interrupt" });
      const checkpoint = await client.getInterruptCheckpoint(threadId, interruptId);
      return await controller.resumeRecovery({
        threadId,
        checkpointReader: async () => ({ ...checkpoint, session_id: checkpoint.session?.session_id, session_revision: checkpoint.session?.revision, session_storage_ref: checkpoint.session?.storage_ref }),
        decision: { interrupt_id: checkpoint.interrupt_id, run_id: checkpoint.run_id, operation_id: checkpoint.operation_id, checkpoint_id: checkpoint.checkpoint_id, receipt_id: "", status: body.status, payload: { approved: body.payload.approved } },
      });
    } catch (error) { return reply.code(error instanceof Error && /active|checkpoint|match|approved|open/i.test(error.message) ? 409 : 500).send({ detail: error instanceof Error ? error.message : "cannot resume" }); }
  });
}
