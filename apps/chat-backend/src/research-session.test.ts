import { describe, expect, it, vi } from "vitest";

import { ResearchClient } from "./research-client.js";
import { createResearchTools } from "./pi/research-tools.js";
import { createResearchSession } from "./pi/research-session.js";

describe("research-only pi session", () => {
  it("rejects non-loopback research service URLs", () => {
    expect(() => new ResearchClient("https://example.com")).toThrow(/loopback/);
  });

  it("defines exactly the two constrained research tools", () => {
    const tools = createResearchTools({} as ResearchClient);
    expect(tools.map((tool) => tool.name)).toEqual([
      "query_company_snapshot",
      "save_research_note",
    ]);
    expect(tools[0].parameters.properties.ticker.const).toBe("300476.SZ");
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
      runtimeDir: "/tmp/ira-task4-test",
      createAgentSession,
      modelRuntime: {} as never,
      model: {} as never,
    });
    const options = createAgentSession.mock.calls[0][0];
    expect(options.noTools).toBe("builtin");
    expect(options.tools).toBeUndefined();
    expect(options.customTools).toHaveLength(2);
    expect(options.settingsManager).toBeDefined();
    expect(options.resourceLoader.getExtensions().extensions).toEqual([]);
    expect(options.resourceLoader.getSkills().skills).toEqual([]);
    expect(options.resourceLoader.getPrompts().prompts).toEqual([]);
  });
});
