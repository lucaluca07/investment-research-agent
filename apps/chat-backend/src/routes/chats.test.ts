import { describe, expect, it, vi } from "vitest";

import { createApp } from "../app.js";
import { ResearchClientError } from "../research-client.js";

describe("chat routes", () => {
  it("persists the default and LLM_MODEL override", async () => {
    const original = process.env.LLM_MODEL;
    const createRun = vi.fn().mockResolvedValue({ id: "run-model", chat_id: "chat-model", pi_session_id: "pi", model: "k3-256k", status: "running", error: null, created_at: new Date().toISOString() });
    const app = await createApp({
      researchClient: { createChat: vi.fn().mockResolvedValue({ id: "chat-model", pi_session_id: "pi" }), createRun, appendMessage: vi.fn().mockResolvedValue({ id: "message-1", role: "user", content: "hello" }) } as never,
      sessionFactory: vi.fn().mockResolvedValue({ prompt: vi.fn(), subscribe: vi.fn().mockReturnValue(() => {}), dispose: vi.fn() }),
    });
    try {
      delete process.env.LLM_MODEL;
      await app.inject({ method: "POST", url: "/v1/chats" });
      await app.inject({ method: "POST", url: "/v1/chats/chat-model/messages", payload: { content: "hello", idempotency_key: "model-default" } });
      expect(createRun.mock.calls[0][0].model).toBe("k3-256k");
      process.env.LLM_MODEL = "research-model";
      const appOverride = await createApp({ researchClient: { listChats: vi.fn().mockResolvedValue([{ id: "chat-override", pi_session_id: "pi" }]), createRun, appendMessage: vi.fn().mockResolvedValue({ id: "message-2", role: "user", content: "hello" }) } as never, sessionFactory: vi.fn().mockResolvedValue({ prompt: vi.fn(), subscribe: vi.fn().mockReturnValue(() => {}), dispose: vi.fn() }) });
      await appOverride.inject({ method: "POST", url: "/v1/chats/chat-override/messages", payload: { content: "hello", idempotency_key: "model-override" } });
      expect(createRun.mock.calls[1][0].model).toBe("research-model");
      await appOverride.close();
    } finally {
      if (original === undefined) delete process.env.LLM_MODEL; else process.env.LLM_MODEL = original;
      await app.close();
    }
  });

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
    const appendEvent = vi.fn().mockImplementation(async (_chatId, event) => ({ id: 1, ...event }));
    const app = await createApp({
      researchClient: {
        createChat: vi.fn().mockResolvedValue({ id: "chat-real", pi_session_id: "pi-stable" }),
        appendMessage: vi.fn().mockResolvedValue({ id: "message-1", role: "user", content: "hello" }),
        createRun: vi.fn().mockResolvedValue({ id: "run-real" }),
        appendEvent,
        updateRun: vi.fn(),
      } as never,
      sessionFactory: vi.fn().mockResolvedValue({ prompt: vi.fn(() => new Promise<void>(() => undefined)), subscribe: vi.fn((callback) => { listener = callback; return () => {}; }), dispose: vi.fn() }),
    });
    await app.inject({ method: "POST", url: "/v1/chats", payload: {} });
    await app.inject({ method: "POST", url: "/v1/chats/chat-real/messages", payload: { content: "hello", idempotency_key: "real-1" } });
    listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } });
    await vi.waitFor(() => expect(appendEvent).toHaveBeenCalledWith("chat-real", {
      type: "message.delta",
      data: { run_id: "run-real", delta: "ok" },
    }));
    expect((app as any).chatRegistry).toBeDefined();
    await app.close();
  });
});
