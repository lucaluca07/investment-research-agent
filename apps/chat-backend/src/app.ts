import Fastify, { type FastifyInstance } from "fastify";
import { ChatRegistry } from "./chat-registry.js";
import { ResearchClient } from "./research-client.js";
import { registerChatRoutes } from "./routes/chats.js";

export type AppOptions = {
  researchClient?: ResearchClient;
  sessionFactory?: (chatId: string) => Promise<any>;
};

export async function createApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify();
  const client = options.researchClient ?? new ResearchClient(process.env.IRA_RESEARCH_SERVICE_URL ?? "http://127.0.0.1:8000");
  const registry = new ChatRegistry(client, options.sessionFactory);
  try { await registry.restore(); } catch { /* service may be unavailable until first request */ }
  app.decorate("chatRegistry", registry);
  app.addHook("onClose", async () => registry.dispose());
  await registerChatRoutes(app, client, registry);
  return app;
}

declare module "fastify" {
  interface FastifyInstance { chatRegistry: ChatRegistry; }
}
