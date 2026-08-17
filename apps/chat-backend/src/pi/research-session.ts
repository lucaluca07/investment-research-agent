import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { ResearchClient } from "../research-client.js";
import { createResearchTools } from "./research-tools.js";
import { loadModelConfig, writeModelDocument } from "./model-config.js";

type Model = ReturnType<ModelRuntime["getModels"]>[number];

const RESEARCH_LEAD_PROMPT =
  "You are the Research Lead. Answer one Victory Giant Technology (胜宏科技) PCB research question using only the two provided research tools. Cite every factual claim and never use unavailable tools or invent evidence.";

type SessionFactory = (options: Record<string, unknown>) => Promise<unknown>;

export type ResearchSessionOptions = {
  client?: ResearchClient;
  sessionId: string;
  runtimeDir?: string;
  createAgentSession?: SessionFactory;
  modelRuntime?: ModelRuntime;
  model?: Model;
  environment?: NodeJS.ProcessEnv;
  createModelRuntime?: (options: { authPath: string; modelsPath: string; allowModelNetwork: boolean }) => Promise<ModelRuntime>;
};

export async function createResearchSession(options: ResearchSessionOptions): Promise<unknown> {
  if (!options.sessionId?.trim()) throw new Error("sessionId is required");
  const environment = options.environment ?? process.env;
  const modelConfig = loadModelConfig(environment);
  const runtimeDir = options.runtimeDir ?? process.env.IRA_RUNTIME_DIR ?? path.join(process.cwd(), ".ira-runtime");
  const sessionKey = createHash("sha256").update(options.sessionId).digest("hex").slice(0, 32);
  const sessionRoot = path.join(runtimeDir, "sessions", sessionKey);
  const cwd = path.join(sessionRoot, "empty-cwd");
  const agentDir = path.join(sessionRoot, "agent");
  const sessionDir = path.join(sessionRoot, "session");
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true }), mkdir(sessionDir, { recursive: true })]);

  const client = options.client ?? new ResearchClient(process.env.IRA_RESEARCH_SERVICE_URL ?? "http://127.0.0.1:8000");
  const modelsPath = await writeModelDocument(agentDir, modelConfig);
  const runtimeFactory = options.createModelRuntime ?? ((runtimeOptions) => ModelRuntime.create(runtimeOptions));
  const modelRuntime = options.modelRuntime ?? await runtimeFactory({ authPath: path.join(agentDir, "auth.json"), modelsPath, allowModelNetwork: false });
  await modelRuntime.setRuntimeApiKey(modelConfig.providerId, modelConfig.apiKey);
  const model = options.model ?? modelRuntime.getModel(modelConfig.providerId, modelConfig.modelId);
  if (!model) throw new Error(`Configured model is unavailable: ${modelConfig.modelId}`);
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader: ResourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: RESEARCH_LEAD_PROMPT,
  });
  await resourceLoader.reload({ resolveProjectTrust: async () => true });
  const sessionFactory = options.createAgentSession ?? (createAgentSession as unknown as SessionFactory);
  return sessionFactory({
    cwd,
    agentDir,
    sessionManager: SessionManager.create(cwd, sessionDir),
    settingsManager,
    modelRuntime,
    model,
    thinkingLevel: modelConfig.reasoningEffort,
    noTools: "builtin",
    customTools: createResearchTools(client),
    resourceLoader,
  });
}
