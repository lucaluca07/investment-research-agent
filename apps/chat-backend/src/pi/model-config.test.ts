import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadModelConfig, writeModelDocument } from "./model-config.js";

describe("model configuration", () => {
  it("uses Kimi Coding Plan defaults when only KIMI_API_KEY is set", () => {
    const config = loadModelConfig({ KIMI_API_KEY: "secret" });
    expect(config).toMatchObject({ providerId: "openai-compatible", baseUrl: "https://api.kimi.com/coding/v1", modelId: "k3-256k", contextWindow: 262144, reasoningEffort: "high", supportsVision: true, compatProfile: "kimi", apiKey: "secret" });
  });

  it("writes a Kimi-compatible model document without the API key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ira-model-config-"));
    const config = loadModelConfig({ KIMI_API_KEY: "never-write-this" });
    const path = await writeModelDocument(directory, config);
    const text = await readFile(path, "utf8");
    expect(text).not.toContain("never-write-this");
    expect(JSON.parse(text)).toMatchObject({ providers: { "openai-compatible": { api: "openai-completions", baseUrl: "https://api.kimi.com/coding/v1", compat: { deferredToolsMode: "kimi" }, models: [{ id: "k3-256k", contextWindow: 262144 }] } } });
  });

  it("accepts a standard OpenAI-compatible override", () => {
    expect(loadModelConfig({ LLM_API_KEY: "key", LLM_BASE_URL: "https://llm.example.com/v1", LLM_MODEL: "research-model", LLM_CONTEXT_LENGTH: "131072", LLM_REASONING_EFFORT: "medium", LLM_SUPPORTS_VISION: "false", LLM_COMPAT_PROFILE: "openai" })).toMatchObject({ baseUrl: "https://llm.example.com/v1", modelId: "research-model", contextWindow: 131072, reasoningEffort: "medium", supportsVision: false, compatProfile: "openai" });
  });

  it.each([
    [{ KIMI_API_KEY: "" }, /API key/],
    [{ KIMI_API_KEY: "key", LLM_BASE_URL: "http://example.com/v1" }, /HTTPS or loopback/],
    [{ KIMI_API_KEY: "key", LLM_CONTEXT_LENGTH: "0" }, /context length/],
    [{ KIMI_API_KEY: "key", LLM_SUPPORTS_VISION: "yes" }, /boolean/],
    [{ KIMI_API_KEY: "key", LLM_COMPAT_PROFILE: "custom" }, /compatibility profile/],
    [{ KIMI_API_KEY: "key", LLM_REASONING_EFFORT: "extreme" }, /reasoning effort/],
  ])("rejects invalid configuration %#", (environment, expected) => {
    expect(() => loadModelConfig(environment)).toThrow(expected);
  });
});
