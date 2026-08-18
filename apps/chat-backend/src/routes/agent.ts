import type { FastifyInstance } from "fastify";
import { RunController } from "../ag-ui/run-controller.js";
import type { ResearchClient } from "../research-client.js";
import { ResearchClientError } from "../research-client.js";

export async function registerAgentRoutes(
  app: FastifyInstance,
  client: ResearchClient,
  controller: RunController,
): Promise<void> {
  const streamRun = async (request: any, reply: any) => {
    const threadId = (request.params as { threadId: string }).threadId;
    const body = (request.body ?? {}) as {
      input?: unknown;
      idempotency_key?: string;
      model?: string;
    };
    if (!body.idempotency_key?.trim())
      return reply.code(422).send({ detail: "idempotency_key is required" });
    try {
      const result = await controller.start(
        threadId,
        body.input ?? "",
        body.idempotency_key,
        body.model,
      );
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const seen = new Set<number>();
      const write = (event: any) => {
        const seq = event.sequence;
        if (typeof seq === "number" && seen.has(seq)) return;
        if (typeof seq === "number") seen.add(seq);
        const id = typeof event.sequence === "number" ? event.sequence : seq;
        reply.raw.write(
          `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data ?? event)}\n\n`,
        );
      };
      let replaying = true;
      const pending: unknown[] = [];
      const unsubscribe = controller.subscribe(threadId, (event) => {
        if (replaying) pending.push(event);
        else write(event);
      });
      const headerCursor = Number(request.headers["last-event-id"] ?? 0);
      const queryCursor = Number((request.query as { after?: string }).after ?? 0);
      for (const event of await client.listAguiEvents(threadId, Math.max(headerCursor || 0, queryCursor || 0)))
        write(event);
      replaying = false;
      for (const event of pending) write(event);
      request.raw.on("close", unsubscribe);
      await result.done;
      unsubscribe();
      reply.raw.end();
    } catch (error) {
      if (!reply.sent)
        return reply
          .code(
            error instanceof Error && error.message.includes("active")
              ? 409
              : 500,
          )
          .send({
            detail: error instanceof Error ? error.message : "run failed",
          });
    }
  };
  app.post("/v1/threads/:threadId/runs", streamRun);
  app.get("/v1/threads/:threadId/events", async (request) => {
    const q = request.query as { after?: string };
    const headerCursor = Number(request.headers["last-event-id"] ?? 0);
    return client.listAguiEvents(
      (request.params as { threadId: string }).threadId,
      Math.max(Number(q.after ?? 0), Number.isFinite(headerCursor) ? headerCursor : 0),
    );
  });
  app.get("/v1/threads/:threadId/state", async (request) =>
    client.getAguiState((request.params as { threadId: string }).threadId),
  );
  app.post("/v1/threads/:threadId/stop", async (request, reply) => {
    try {
      return await controller.stop(
        (request.params as { threadId: string }).threadId,
      );
    } catch (error) {
      return reply.code(409).send({
        detail: error instanceof Error ? error.message : "cannot stop run",
      });
    }
  });
  app.post(
    "/v1/threads/:threadId/interrupts/resume",
    async (request, reply) => {
      const threadId = (request.params as { threadId: string }).threadId;
      const body = (request.body ?? {}) as { decisions?: unknown };
      if (!Array.isArray(body.decisions) || body.decisions.length === 0)
        return reply
          .code(422)
          .send({ detail: "decisions must be a non-empty array" });
      const decisions: Array<{
        interrupt_id: string;
        nonce: string;
        status: "resolved" | "cancelled";
        payload: { approved: boolean };
        payload_hash?: string;
      }> = [];
      for (const value of body.decisions) {
        if (!value || typeof value !== "object")
          return reply.code(422).send({ detail: "invalid decision" });
        const item = value as Record<string, unknown>;
        const payload = item.payload as Record<string, unknown> | undefined;
        if (
          typeof item.interrupt_id !== "string" ||
          !item.interrupt_id ||
          typeof item.nonce !== "string" ||
          !item.nonce ||
          (item.status !== "resolved" && item.status !== "cancelled") ||
          !payload ||
          typeof payload.approved !== "boolean" ||
          (item.payload_hash !== undefined &&
            typeof item.payload_hash !== "string")
        )
          return reply.code(422).send({ detail: "invalid decision schema" });
        decisions.push({
          interrupt_id: item.interrupt_id,
          nonce: item.nonce,
          status: item.status,
          payload: { approved: payload.approved },
          ...(typeof item.payload_hash === "string"
            ? { payload_hash: item.payload_hash }
            : {}),
        });
      }
      if (
        new Set(decisions.map((decision) => decision.interrupt_id)).size !==
        decisions.length
      )
        return reply.code(422).send({ detail: "duplicate interrupt_id" });
      try {
        const resolved = await client.resolveInterruptSet(threadId, decisions);
        return await controller.resumeRecoverySet({
          threadId,
          checkpoints: resolved.checkpoints,
          decisions: resolved.receipts,
        });
      } catch (error) {
        const status =
          error instanceof ResearchClientError &&
          (error.status === 409 || error.status === 422)
            ? error.status
            : error instanceof Error &&
                /active|checkpoint|match|approved|open|decision/i.test(
                  error.message,
                )
              ? 409
              : 500;
        return reply.code(status).send({
          detail: error instanceof Error ? error.message : "cannot resume",
        });
      }
    },
  );
  app.post(
    "/v1/threads/:threadId/interrupts/:interruptId/resume",
    async (request, reply) => {
      const { threadId, interruptId } = request.params as {
        threadId: string;
        interruptId: string;
      };
      const body = (request.body ?? {}) as {
        status?: "resolved" | "cancelled";
        payload?: { approved?: unknown };
      };
      if (
        (body.status !== "resolved" && body.status !== "cancelled") ||
        typeof body.payload?.approved !== "boolean"
      )
        return reply
          .code(422)
          .send({ detail: "status and payload.approved are required" });
      try {
        const checkpoint = await client.getInterruptCheckpoint(
          threadId,
          interruptId,
        );
        const resolved = await client.resolveInterruptSet(threadId, [
          {
            interrupt_id: checkpoint.interrupt_id,
            nonce: checkpoint.nonce,
            status: body.status,
            payload: { approved: body.payload.approved },
          },
        ]);
        return await controller.resumeRecoverySet({
          threadId,
          checkpoints: resolved.checkpoints,
          decisions: resolved.receipts,
        });
      } catch (error) {
        return reply
          .code(
            error instanceof ResearchClientError &&
              (error.status === 409 || error.status === 422)
              ? error.status
              : error instanceof Error &&
                  /active|checkpoint|match|approved|open|decision/i.test(
                    error.message,
                  )
                ? 409
                : 500,
          )
          .send({
            detail: error instanceof Error ? error.message : "cannot resume",
          });
      }
    },
  );
}
