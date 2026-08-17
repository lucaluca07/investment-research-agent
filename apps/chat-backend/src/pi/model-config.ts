import { mkdir, rename, writeFile } from "node:fs/promises";
import { chmod } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export const MODEL_PROVIDER_ID = "openai-compatible";
export const DEFAULT_MODEL_ID = "k3-256k";
export type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high";
export type CompatProfile = "openai" | "kimi";

export type ModelConfig = {
  providerId: typeof MODEL_PROVIDER_ID;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  contextWindow: number;
  reasoningEffort: ReasoningEffort;
  supportsVision: boolean;
  compatProfile: CompatProfile;
};

const defaults = {
  baseUrl: "https://api.kimi.com/coding/v1",
  modelId: DEFAULT_MODEL_ID,
  contextWindow: 262144,
  reasoningEffort: "high" as const,
  supportsVision: true,
  compatProfile: "kimi" as const,
};

const reasoningEfforts: readonly ReasoningEffort[] = ["off", "minimal", "low", "medium", "high"];

export function loadModelConfig(environment: NodeJS.ProcessEnv): ModelConfig {
  const apiKey = environment.LLM_API_KEY?.trim() || environment.KIMI_API_KEY?.trim();
  if (!apiKey) throw new Error("LLM_API_KEY or KIMI_API_KEY is required: API key is missing");

  const baseUrl = environment.LLM_BASE_URL?.trim() || defaults.baseUrl;
  validateBaseUrl(baseUrl);
  const modelId = environment.LLM_MODEL?.trim() || defaults.modelId;
  if (!modelId) throw new Error("model identifier must not be empty");
  const contextWindow = environment.LLM_CONTEXT_LENGTH === undefined
    ? defaults.contextWindow
    : parsePositiveSafeInteger(environment.LLM_CONTEXT_LENGTH);
  const reasoningEffort = environment.LLM_REASONING_EFFORT === undefined
    ? defaults.reasoningEffort
    : parseReasoningEffort(environment.LLM_REASONING_EFFORT);
  const supportsVision = environment.LLM_SUPPORTS_VISION === undefined
    ? defaults.supportsVision
    : parseBoolean(environment.LLM_SUPPORTS_VISION);
  const compatProfile = environment.LLM_COMPAT_PROFILE === undefined
    ? defaults.compatProfile
    : parseCompatProfile(environment.LLM_COMPAT_PROFILE);

  return { providerId: MODEL_PROVIDER_ID, baseUrl, apiKey, modelId, contextWindow, reasoningEffort, supportsVision, compatProfile };
}

export function buildModelDocument(config: ModelConfig): Record<string, unknown> {
  const compat = config.compatProfile === "kimi"
    ? { supportsReasoningEffort: true, deferredToolsMode: "kimi" }
    : { supportsReasoningEffort: true };
  return {
    providers: {
      [config.providerId]: {
        api: "openai-completions",
        baseUrl: config.baseUrl,
        compat,
        models: [{ id: config.modelId, contextWindow: config.contextWindow, reasoningEffort: config.reasoningEffort, supportsVision: config.supportsVision }],
      },
    },
  };
}

export async function writeModelDocument(agentDir: string, config: ModelConfig): Promise<string> {
  await mkdir(agentDir, { recursive: true });
  const path = join(agentDir, "models.json");
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(buildModelDocument(config), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
  return path;
}

function validateBaseUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("base URL must use HTTPS or loopback HTTP"); }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(hostname);
  if (url.protocol !== "https:" && !loopback) throw new Error("base URL must use HTTPS or loopback HTTP");
}

function parsePositiveSafeInteger(value: string): number {
  if (!/^\d+$/.test(value.trim())) throw new Error("context length must be a positive safe integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("context length must be a positive safe integer");
  return parsed;
}

function parseBoolean(value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("supports vision must be a boolean");
}

function parseReasoningEffort(value: string): ReasoningEffort {
  if (!reasoningEfforts.includes(value as ReasoningEffort)) throw new Error("invalid reasoning effort");
  return value as ReasoningEffort;
}

function parseCompatProfile(value: string): CompatProfile {
  if (value !== "openai" && value !== "kimi") throw new Error("invalid compatibility profile");
  return value;
}
