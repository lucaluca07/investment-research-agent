import { describe, expect, it, vi } from "vitest";

import { createApp } from "../app.js";

describe("chat routes", () => {
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
});
