import { describe, expect, it, vi } from "vitest";

import { createApp } from "../app.js";
import { ResearchClientError } from "../research-client.js";

describe("chat routes", () => {
  it("lists persisted chats", async () => {
    const app = await createApp({ researchClient: { listChats: vi.fn().mockResolvedValue([{ id: "chat-1", pi_session_id: "pi-1" }]) } as never, sessionFactory: vi.fn() });
    const response = await app.inject({ method: "GET", url: "/v1/chats" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ id: "chat-1", pi_session_id: "pi-1" }]);
    await app.close();
  });

  it("maps chat list upstream errors", async () => {
    const app = await createApp({ researchClient: { listChats: vi.fn().mockRejectedValue(new ResearchClientError("upstream unavailable", 503, { detail: "down" })) } as never, sessionFactory: vi.fn() });
    const response = await app.inject({ method: "GET", url: "/v1/chats" });
    expect(response.statusCode).toBe(503);
    await app.close();
  });
  it("returns 404 for an unknown chat", async () => {
    const app = await createApp({
      researchClient: {} as never,
      sessionFactory: vi.fn(),
    });
    const response = await app.inject({ method: "GET", url: "/v1/chats/missing/messages" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("deduplicates a message with the same idempotency key", async () => {
    const prompt = vi.fn().mockResolvedValue(undefined);
    const app = await createApp({
      researchClient: {
        createChat: vi.fn().mockResolvedValue({ id: "chat-1" }),
        appendMessage: vi.fn().mockResolvedValue({ id: "message-1", role: "user", content: "hello" }),
        getChatHistory: vi.fn().mockResolvedValue({ messages: [] }),
        createRun: vi.fn().mockResolvedValue({ id: "run-1" }),
      } as never,
      sessionFactory: vi.fn().mockResolvedValue({ prompt, subscribe: vi.fn().mockReturnValue(() => {}), dispose: vi.fn() }),
    });
    await app.inject({ method: "POST", url: "/v1/chats", payload: {} });
    const payload = { content: "hello", idempotency_key: "stable-1" };
    const first = await app.inject({ method: "POST", url: "/v1/chats/chat-1/messages", payload });
    const second = await app.inject({ method: "POST", url: "/v1/chats/chat-1/messages", payload });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(prompt).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("handles real pi delta events using the bound run context", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const app = await createApp({
      researchClient: {
        createChat: vi.fn().mockResolvedValue({ id: "chat-real", pi_session_id: "pi-stable" }),
        appendMessage: vi.fn().mockResolvedValue({ id: "message-1", role: "user", content: "hello" }),
        createRun: vi.fn().mockResolvedValue({ id: "run-real" }),
        appendEvent: vi.fn().mockResolvedValue({ id: 1, type: "message.delta", data: { delta: "ok" } }),
        updateRun: vi.fn(),
      } as never,
      sessionFactory: vi.fn().mockResolvedValue({ prompt: vi.fn(() => new Promise<void>(() => undefined)), subscribe: vi.fn((callback) => { listener = callback; return () => {}; }), dispose: vi.fn() }),
    });
    await app.inject({ method: "POST", url: "/v1/chats", payload: {} });
    await app.inject({ method: "POST", url: "/v1/chats/chat-real/messages", payload: { content: "hello", idempotency_key: "real-1" } });
    listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } });
    expect((app as any).chatRegistry).toBeDefined();
    await app.close();
  });
});
