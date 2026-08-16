import { mkdir } from "node:fs/promises";
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

type Model = ReturnType<ModelRuntime["getModels"]>[number];

const RESEARCH_LEAD_PROMPT =
  "You are the Research Lead. Answer one Victory Giant Technology (胜宏科技) PCB research question using only the two provided research tools. Cite every factual claim and never use unavailable tools or invent evidence.";

type SessionFactory = (options: Record<string, unknown>) => Promise<unknown>;

export type ResearchSessionOptions = {
  client?: ResearchClient;
  runtimeDir?: string;
  createAgentSession?: SessionFactory;
  modelRuntime?: ModelRuntime;
  model?: Model;
};

export async function createResearchSession(options: ResearchSessionOptions = {}): Promise<unknown> {
  const runtimeDir = options.runtimeDir ?? process.env.IRA_RUNTIME_DIR ?? path.join(process.cwd(), ".ira-runtime");
  const cwd = path.join(runtimeDir, "empty-cwd");
  const agentDir = path.join(runtimeDir, "agent");
  const sessionDir = path.join(runtimeDir, "sessions");
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true }), mkdir(sessionDir, { recursive: true })]);

  const client = options.client ?? new ResearchClient(process.env.IRA_RESEARCH_SERVICE_URL ?? "http://127.0.0.1:8000");
  const modelRuntime = options.modelRuntime ?? await createModelRuntime(agentDir);
  const model = options.model ?? selectModel(modelRuntime);
  const resourceLoader: ResourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
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
    settingsManager: SettingsManager.inMemory(),
    modelRuntime,
    model,
    noTools: "builtin",
    customTools: createResearchTools(client),
    resourceLoader,
  });
}

async function createModelRuntime(agentDir: string): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
  const provider = process.env.IRA_PI_PROVIDER;
  const apiKey = process.env.IRA_PI_API_KEY;
  if (provider && apiKey) await runtime.setRuntimeApiKey(provider, apiKey);
  return runtime;
}

function selectModel(runtime: ModelRuntime): Model {
  const provider = process.env.IRA_PI_PROVIDER;
  const modelId = process.env.IRA_PI_MODEL;
  const model = provider && modelId ? runtime.getModel(provider, modelId) : runtime.getModels()[0];
  if (!model) throw new Error("No pi model is configured for the research session");
  return model;
}
