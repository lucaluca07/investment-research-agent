import { describe, expect, it } from "vitest";
import { ResearchClient } from "./research-client.js";

describe("AG-UI research client", () => {
  it("creates a loopback client and exposes AG-UI methods", () => {
    const client = new ResearchClient("http://127.0.0.1:8000");
    expect(client.createThread).toBeTypeOf("function");
    expect(client.appendAguiEvents).toBeTypeOf("function");
  });
  it("rejects malformed thread responses at the boundary", async () => {
    const client = new ResearchClient("http://127.0.0.1:8000", { fetch: async () => new Response(JSON.stringify([{ id: "x" }]), { status: 200 }) });
    await expect(client.listThreads()).rejects.toThrow("invalid thread response");
  });
});
