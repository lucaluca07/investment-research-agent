import { describe, expect, it } from "vitest";
import { ResearchClient } from "./research-client.js";

describe("AG-UI research client", () => {
  it("creates a loopback client and exposes AG-UI methods", () => {
    const client = new ResearchClient("http://127.0.0.1:8000");
    expect(client.createThread).toBeTypeOf("function");
    expect(client.appendAguiEvents).toBeTypeOf("function");
  });
});
