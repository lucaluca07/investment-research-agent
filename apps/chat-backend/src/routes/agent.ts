import type { FastifyInstance } from "fastify";
import { RunController } from "../ag-ui/run-controller.js";
import type { ResearchClient } from "../research-client.js";
import { ResearchClientError } from "../research-client.js";

export async function registerAgentRoutes(
  app: FastifyInstance,
  client: ResearchClient,
  controller: RunController,
): Promise<void> {
  app.get("/v1/threads", async () => client.listThreads());
  app.post("/v1/threads", async (request, reply) => {
    const body = (request.body ?? {}) as { title?: unknown; id?: unknown };
    if (body.title !== undefined && typeof body.title !== "string")
      return reply.code(422).send({ detail: "title must be a string" });
    if (body.id !== undefined && typeof body.id !== "string")
      return reply.code(422).send({ detail: "id must be a string" });
    const thread = await client.createThread(body.title ?? "", body.id);
    return reply.code(201).send(thread);
  });
  app.post("/v1/runs/:runId/transition", async (request, reply) => {
    const body = (request.body ?? {}) as { status?: unknown; error?: unknown };
    const statuses = ["pending", "running", "completed", "interrupted", "failed", "cancelled"] as const;
    if (typeof body.status !== "string" || !statuses.includes(body.status as typeof statuses[number]))
      return reply.code(422).send({ detail: "status is required" });
    return client.transitionAguiRun(
      (request.params as { runId: string }).runId,
      body.status as typeof statuses[number],
      body.error && typeof body.error === "object" ? body.error as Record<string, unknown> : undefined,
    );
  });
  const startRun = async (request: any, reply: any) => {
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
      return reply.code(result.replayed ? 200 : 202).send({
        run: result.run,
        replayed: result.replayed,
        last_event_seq: result.last_event_seq,
      });
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
  app.post("/v1/threads/:threadId/runs", startRun);
  app.get("/v1/threads/:threadId/events", async (request, reply) => {
    const threadId = (request.params as { threadId: string }).threadId;
    const q = request.query as { after?: string };
    const headerCursor = Number(request.headers["last-event-id"] ?? 0);
    const after = Math.max(Number(q.after ?? 0), Number.isFinite(headerCursor) ? headerCursor : 0);
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const seen = new Set<number>();
    const write = (event: any) => {
      if (!Number.isInteger(event?.sequence) || seen.has(event.sequence)) return;
      seen.add(event.sequence);
      reply.raw.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data ?? {})}\n\n`);
    };
    let replaying = true;
    const pending: unknown[] = [];
    const subscription = controller.subscribeWithCompletion(threadId, (event) => {
      if (replaying) pending.push(event);
      else write(event);
    });
    let replayComplete = false;
    let runComplete = false;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      subscription.unsubscribe();
      request.raw.off("close", close);
      if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end();
    };
    const closeWhenReady = () => {
      if (replayComplete && runComplete) close();
    };
    void subscription.done.then(
      () => {
        runComplete = true;
        closeWhenReady();
      },
      () => {
        runComplete = true;
        closeWhenReady();
      },
    );
    for (const event of await client.listAguiEvents(threadId, after)) write(event);
    replaying = false;
    for (const event of pending) write(event);
    replayComplete = true;
    closeWhenReady();
    if (!closed) request.raw.once("close", close);
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
