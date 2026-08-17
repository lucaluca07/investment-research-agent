import { describe, expect, it } from "vitest";
import config from "../vite.config.js";

describe("Vite development proxy", () => {
  it("forwards relative API and SSE requests to the chat backend", () => {
    expect(config.server?.proxy?.["/v1"]).toMatchObject({
      target: "http://127.0.0.1:8020",
    });
  });
});
