import { Type, type Static } from "typebox";
import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { ResearchClient } from "../research-client.js";

const queryParameters = Type.Object({ ticker: Type.Literal("300476.SZ") });
const saveParameters = Type.Object({
  run_id: Type.String({ minLength: 1 }),
  idempotency_key: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  body: Type.String({ minLength: 1 }),
  citation_ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
});

function result(value: unknown): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: undefined };
}

export function createResearchTools(client: ResearchClient): [
  ToolDefinition<typeof queryParameters>,
  ToolDefinition<typeof saveParameters>,
] {
  return [
    defineTool({
      name: "query_company_snapshot",
      label: "Query company snapshot",
      description: "Query the dated Victory Giant Technology company snapshot.",
      parameters: queryParameters,
      async execute(_id, params: Static<typeof queryParameters>) {
        return result(await client.queryCompanySnapshot(params.ticker));
      },
    }),
    defineTool({
      name: "save_research_note",
      label: "Save research note",
      description: "Save an evidence-backed research note with stable idempotency.",
      parameters: saveParameters,
      async execute(_id, params: Static<typeof saveParameters>) {
        return result(await client.saveResearchNote(params));
      },
    }),
  ];
}
