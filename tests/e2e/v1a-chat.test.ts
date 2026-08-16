import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../apps/chat-backend/src/app.js";
import { FakeAgentSession } from "./fake-agent-session.js";

describe("V1a crash recovery contract", () => {
  it("completes a chat turn and preserves idempotency across backend recreation", async () => {
    const runs = new Map<string, any>(); const messages = new Map<string, any[]>(); const events = new Map<string, any[]>();
    const client: any = {
      listChats: vi.fn().mockResolvedValue([{ id: "chat-e2e", pi_session_id: "pi-stable" }]),
      getChatHistory: vi.fn().mockImplementation(async (chat_id: string) => ({ messages: messages.get(chat_id) ?? [] })),
      createRun: vi.fn().mockImplementation(async (request: any) => { const existing = [...runs.values()].find((run) => run.idempotency_key === request.idempotency_key); if (existing) return { ...existing, replayed: true }; const run = { id: "run-e2e", ...request, status: "running", error: null, created_at: new Date().toISOString() }; runs.set(run.id, run); return run; }),
      appendMessage: vi.fn().mockImplementation(async (chat_id: string, request: any) => { const message = { id: `${request.role}-1`, chat_id, ...request, created_at: new Date().toISOString() }; messages.set(chat_id, [...(messages.get(chat_id) ?? []), message]); return message; }),
      appendEvent: vi.fn().mockImplementation(async (chat_id: string, event: any) => { const list = events.get(chat_id) ?? []; const saved = { id: list.length + 1, ...event }; events.set(chat_id, [...list, saved]); return saved; }),
      listEvents: vi.fn().mockImplementation(async (chat_id: string, after = 0) => (events.get(chat_id) ?? []).filter((event: any) => event.id > after)),
      getRun: vi.fn().mockImplementation(async (run_id: string) => runs.get(run_id)),
      updateRun: vi.fn().mockImplementation(async (run_id: string, status: string) => { runs.get(run_id).status = status; }),
    };
    const sessions: FakeAgentSession[] = [];
    const factory = async (sessionId: string) => { const session = new FakeAgentSession(sessionId); sessions.push(session); return session; };
    const first = await createApp({ researchClient: client, sessionFactory: factory });
    expect((await first.inject({ method: "GET", url: "/v1/chats" })).json()[0].pi_session_id).toBe("pi-stable");
    const send = await first.inject({ method: "POST", url: "/v1/chats/chat-e2e/messages", payload: { content: "research", idempotency_key: "e2e-1" } });
    expect(send.statusCode).toBe(202); await new Promise((resolve) => setTimeout(resolve, 0)); expect(sessions[0]?.sessionId).toBe("pi-stable");
    expect((await client.listEvents("chat-e2e", 0)).map((event: any) => event.type)).toContain("message.delta");
    await first.close();
    const second = await createApp({ researchClient: client, sessionFactory: factory });
    const duplicate = await second.inject({ method: "POST", url: "/v1/chats/chat-e2e/messages", payload: { content: "research", idempotency_key: "e2e-1" } });
    expect(duplicate.statusCode).toBe(200); expect(client.appendMessage).toHaveBeenCalledTimes(2); expect(sessions).toHaveLength(2); expect(sessions.reduce((total, session) => total + session.promptCalls, 0)).toBe(1); await second.close();
  });
});
