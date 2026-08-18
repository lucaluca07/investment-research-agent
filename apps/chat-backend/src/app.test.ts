import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";

describe("chat backend public service boundary", () => {
  it("starts with health and proxies the web thread-list endpoint to Research Service", async () => {
    const researchClient = {
      listThreads: vi.fn(async () => [{ id: "thread-1", title: "PCB", title_source: "user", title_locked: false, created_at: "now" }]),
    } as any;
    const app = await createApp({ researchClient, sessionFactory: async () => ({ prompt: vi.fn(), subscribe: vi.fn(), dispose: vi.fn() }) });
    try {
      expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ ok: true });
      expect((await app.inject({ method: "GET", url: "/v1/threads" })).json()).toEqual([expect.objectContaining({ id: "thread-1" })]);
      expect(researchClient.listThreads).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });
});
