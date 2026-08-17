import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import { ResearchClient, ResearchClientError } from "./research-client.js";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { createResearchTools } from "./pi/research-tools.js";
import { createResearchSession } from "./pi/research-session.js";

describe("research-only pi session", () => {
  it("configures pi with the selected model and reasoning effort", async () => {
    const setRuntimeApiKey = vi.fn();
    const selectedModel = { provider: "openai-compatible", id: "k3-256k" };
    const runtime = { setRuntimeApiKey, getModel: vi.fn().mockReturnValue(selectedModel) };
    const createAgentSession = vi.fn().mockResolvedValue({ session: {} });
    await createResearchSession({
      client: {} as ResearchClient,
      sessionId: "kimi-chat",
      runtimeDir: "/tmp/ira-kimi-session-test",
      environment: { KIMI_API_KEY: "secret" },
      createModelRuntime: vi.fn().mockResolvedValue(runtime),
      createAgentSession,
    });
    expect(setRuntimeApiKey).toHaveBeenCalledWith("openai-compatible", "secret");
    expect(runtime.getModel).toHaveBeenCalledWith("openai-compatible", "k3-256k");
    const sessionOptions = createAgentSession.mock.calls[0][0];
    expect(sessionOptions).toMatchObject({ model: selectedModel, thinkingLevel: "high", noTools: "builtin" });
    expect(JSON.parse(await readFile(`${sessionOptions.agentDir}/models.json`, "utf8")).providers["openai-compatible"]).toBeDefined();
  });

  it("fails before creating an agent session when the API key is missing", async () => {
    const createAgentSession = vi.fn();
    await expect(createResearchSession({ client: {} as ResearchClient, sessionId: "missing-key", environment: {}, createAgentSession })).rejects.toThrow(/API key/);
    expect(createAgentSession).not.toHaveBeenCalled();
  });

  it("fails before creating an agent session when the configured model is unavailable", async () => {
    const createAgentSession = vi.fn();
    const runtime = { setRuntimeApiKey: vi.fn(), getModel: vi.fn().mockReturnValue(undefined) };
    await expect(createResearchSession({ client: {} as ResearchClient, sessionId: "missing-model", environment: { KIMI_API_KEY: "key" }, createModelRuntime: vi.fn().mockResolvedValue(runtime), createAgentSession })).rejects.toThrow(/Configured model is unavailable/);
    expect(createAgentSession).not.toHaveBeenCalled();
  });

  it("rejects non-loopback research service URLs", () => {
    expect(() => new ResearchClient("https://example.com")).toThrow(/loopback/);
  });

  it("accepts IPv6 loopback and preserves getChatHistory and error bodies", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "citation conflict" }), { status: 409 }));
    const client = new ResearchClient("http://[::1]:8000", { fetch });
    await expect(client.getChatHistory("chat-1")).resolves.toEqual({ messages: [] });
    await expect(client.saveResearchNote({
      run_id: "run-1", idempotency_key: "key", title: "T", body: "B", citation_ids: ["c"],
    })).rejects.toMatchObject({ status: 409, body: { detail: "citation conflict" } } satisfies Partial<ResearchClientError>);
  });

  it("defines exactly the two constrained research tools", () => {
    const tools = createResearchTools({} as ResearchClient);
    expect(tools.map((tool) => tool.name)).toEqual([
      "query_company_snapshot",
      "save_research_note",
    ]);
    expect(tools[0].parameters.properties.ticker.const).toBe("300476.SZ");
    expect(tools.every((tool) => tool.name)).toBe(true);
    expect(tools[1].parameters.properties.run_id).toBeDefined();
    expect(tools[1].parameters.properties.idempotency_key).toBeDefined();
  });

  it("delegates custom tool execution to ResearchClient", async () => {
    const client = {
      queryCompanySnapshot: vi.fn().mockResolvedValue({ ticker: "300476.SZ" }),
      saveResearchNote: vi.fn().mockResolvedValue({ note_id: "note-1" }),
    } as unknown as ResearchClient;
    const [query, save] = createResearchTools(client);
    const queryResult = await query.execute("call-1", { ticker: "300476.SZ" }, undefined, undefined, {} as never);
    const saveResult = await save.execute(
      "call-2",
      { run_id: "run-1", idempotency_key: "stable", title: "T", body: "B", citation_ids: ["c-1"] },
      undefined,
      undefined,
      {} as never,
    );
    expect(client.queryCompanySnapshot).toHaveBeenCalledWith("300476.SZ");
    expect(client.saveResearchNote).toHaveBeenCalledWith({
      run_id: "run-1", idempotency_key: "stable", title: "T", body: "B", citation_ids: ["c-1"],
    });
    expect(queryResult.content[0]).toMatchObject({ type: "text" });
    expect(saveResult.content[0]).toMatchObject({ type: "text" });
  });

  it("builds a session with built-ins disabled and only custom tools", async () => {
    const createAgentSession = vi.fn().mockResolvedValue({ session: { dispose: vi.fn() } });
    await createResearchSession({
      client: {} as ResearchClient,
      sessionId: "chat-1",
      runtimeDir: "/tmp/ira-task4-test",
      createAgentSession,
      modelRuntime: { setRuntimeApiKey: vi.fn(), getModel: vi.fn() } as never,
      model: {} as never,
      environment: { KIMI_API_KEY: "test-key" },
    });
    const options = createAgentSession.mock.calls[0][0];
    expect(options.noTools).toBe("builtin");
    expect(options.tools).toBeUndefined();
    expect(options.customTools).toHaveLength(2);
    expect(options.settingsManager).toBeDefined();
    expect(options.resourceLoader).toBeInstanceOf(DefaultResourceLoader);
    expect(options.resourceLoader.getExtensions().extensions).toEqual([]);
    expect(options.resourceLoader.getSkills().skills).toEqual([]);
    expect(options.resourceLoader.getPrompts().prompts).toEqual([]);
  });

  it("isolates cwd, agentDir, credentials, and session files per stable session id", async () => {
    const createAgentSession = vi.fn().mockResolvedValue({ session: { dispose: vi.fn() } });
    const common = {
      client: {} as ResearchClient,
      runtimeDir: "/tmp/ira-task4-isolation-test",
      createAgentSession,
      modelRuntime: { setRuntimeApiKey: vi.fn(), getModel: vi.fn() } as never,
      model: {} as never,
      environment: { KIMI_API_KEY: "test-key" },
    };
    await createResearchSession({ ...common, sessionId: "chat-alpha" });
    await createResearchSession({ ...common, sessionId: "chat-beta" });
    const first = createAgentSession.mock.calls[0][0];
    const second = createAgentSession.mock.calls[1][0];
    expect(first.cwd).not.toBe(second.cwd);
    expect(first.agentDir).not.toBe(second.agentDir);
    expect(first.sessionManager).not.toBe(second.sessionManager);
    expect(first.cwd).toContain("sessions");
    expect(first.agentDir).toContain("agent");
    expect(first.sessionManager).toBeDefined();
  });
});
