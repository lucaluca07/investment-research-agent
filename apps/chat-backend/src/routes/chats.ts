import type { FastifyInstance } from "fastify";
import type { ResearchClient } from "../research-client.js";
import { ChatRegistry } from "../chat-registry.js";
import { randomUUID } from "node:crypto";

type MessageBody = { content: string; idempotency_key: string };

export async function registerChatRoutes(app: FastifyInstance, client: ResearchClient, registry: ChatRegistry): Promise<void> {
  app.post("/v1/chats", async (request, reply) => {
    const body = (request.body ?? {}) as { chat_id?: string };
    const result = await client.createChat(body.chat_id);
    const chatId = String(result.id ?? body.chat_id ?? randomUUID());
    registry.addChat(chatId);
    return reply.code(201).send({ id: chatId });
  });

  app.get("/v1/chats/:chatId/messages", async (request, reply) => {
    const chatId = (request.params as { chatId: string }).chatId;
    if (!registry.hasChat(chatId)) return reply.code(404).send({ detail: "chat not found" });
    return client.getChatHistory(chatId);
  });

  app.post("/v1/chats/:chatId/messages", async (request, reply) => {
    const chatId = (request.params as { chatId: string }).chatId;
    const body = request.body as MessageBody;
    if (!registry.hasChat(chatId)) return reply.code(404).send({ detail: "chat not found" });
    if (!body || !body.content?.trim() || !body.idempotency_key?.trim()) return reply.code(422).send({ detail: "content and idempotency_key are required" });
    try {
      const result = await registry.prompt(chatId, body.content.trim(), body.idempotency_key.trim());
      return reply.code(result.status === "accepted" ? 202 : 200).send(result);
    } catch (error) {
      if (error instanceof Error && error.message === "chat already has an active run") return reply.code(409).send({ detail: error.message });
      throw error;
    }
  });

  app.post("/v1/chats/:chatId/stop", async (request, reply) => {
    const chatId = (request.params as { chatId: string }).chatId;
    if (!registry.hasChat(chatId)) return reply.code(404).send({ detail: "chat not found" });
    try { return reply.send(await registry.stop(chatId)); }
    catch (error) { return reply.code(409).send({ detail: error instanceof Error ? error.message : "cannot stop run" }); }
  });

  app.get("/v1/chats/:chatId/events", async (request, reply) => {
    const chatId = (request.params as { chatId: string }).chatId;
    if (!registry.hasChat(chatId)) return reply.code(404).send({ detail: "chat not found" });
    const last = Number(request.headers["last-event-id"] ?? (request.query as { lastEventId?: string }).lastEventId);
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const write = (event: { id: number; type: string; data: Record<string, unknown> }) => reply.raw.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    for (const event of registry.getEvents(chatId, Number.isFinite(last) ? last : undefined)) write(event);
    const unsubscribe = registry.subscribe(chatId, write);
    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15000);
    request.raw.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
  });
}
