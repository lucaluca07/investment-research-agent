# OpenAI-Compatible Model Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure pi with a validated OpenAI-compatible model endpoint, using Kimi Coding Plan defaults so local users only need to set `KIMI_API_KEY`.

**Architecture:** Add a focused model-config module that parses environment variables into a typed configuration and writes a credential-free pi `models.json`. The existing research-session module will create `ModelRuntime` from that file, inject the API key only as a runtime override, select the configured model, and pass the configured reasoning level to pi while preserving all existing tool and resource isolation.

**Tech Stack:** TypeScript, Node.js filesystem APIs, pi SDK `0.84.2`, Vitest, pnpm

---

## File map

- Create `apps/chat-backend/src/pi/model-config.ts`: defaults, strict environment parsing, compatibility profile mapping, credential-free pi model document, and atomic file writing.
- Create `apps/chat-backend/src/pi/model-config.test.ts`: configuration defaults, overrides, validation, Kimi compatibility, and secret-exclusion tests.
- Modify `apps/chat-backend/src/pi/research-session.ts`: consume the typed model configuration, initialize `ModelRuntime`, inject credentials, select the model, and set reasoning level.
- Modify `apps/chat-backend/src/research-session.test.ts`: verify session integration without calling a paid model.
- Modify `apps/chat-backend/src/chat-registry.ts`: persist the configured model ID instead of the obsolete `IRA_PI_MODEL` value.
- Modify `apps/chat-backend/src/routes/chats.test.ts`: verify the configured model ID sent to the research service.
- Modify `README.md`: document the one-variable Kimi startup and generic OpenAI-compatible overrides.
- Modify `scripts/dev-v1a.sh`: fail early with a useful message when neither API-key variable is present.

### Task 1: Parse and materialize model configuration

**Files:**
- Create: `apps/chat-backend/src/pi/model-config.ts`
- Create: `apps/chat-backend/src/pi/model-config.test.ts`

- [ ] **Step 1: Write failing tests for Kimi defaults and secret exclusion**

```ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadModelConfig, writeModelDocument } from "./model-config.js";

describe("model configuration", () => {
  it("uses Kimi Coding Plan defaults when only KIMI_API_KEY is set", () => {
    const config = loadModelConfig({ KIMI_API_KEY: "secret" });
    expect(config).toMatchObject({
      providerId: "openai-compatible",
      baseUrl: "https://api.kimi.com/coding/v1",
      modelId: "k3-256k",
      contextWindow: 262144,
      reasoningEffort: "high",
      supportsVision: true,
      compatProfile: "kimi",
      apiKey: "secret",
    });
  });

  it("writes a Kimi-compatible model document without the API key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ira-model-config-"));
    const config = loadModelConfig({ KIMI_API_KEY: "never-write-this" });
    const path = await writeModelDocument(directory, config);
    const text = await readFile(path, "utf8");
    expect(text).not.toContain("never-write-this");
    expect(JSON.parse(text)).toMatchObject({
      providers: {
        "openai-compatible": {
          api: "openai-completions",
          baseUrl: "https://api.kimi.com/coding/v1",
          compat: { deferredToolsMode: "kimi" },
          models: [{ id: "k3-256k", contextWindow: 262144 }],
        },
      },
    });
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @ira/chat-backend test -- model-config.test.ts
```

Expected: FAIL because `./pi/model-config.js` does not exist.

- [ ] **Step 3: Add strict override-validation tests**

```ts
it("accepts a standard OpenAI-compatible override", () => {
  expect(loadModelConfig({
    LLM_API_KEY: "key",
    LLM_BASE_URL: "https://llm.example.com/v1",
    LLM_MODEL: "research-model",
    LLM_CONTEXT_LENGTH: "131072",
    LLM_REASONING_EFFORT: "medium",
    LLM_SUPPORTS_VISION: "false",
    LLM_COMPAT_PROFILE: "openai",
  })).toMatchObject({
    baseUrl: "https://llm.example.com/v1",
    modelId: "research-model",
    contextWindow: 131072,
    reasoningEffort: "medium",
    supportsVision: false,
    compatProfile: "openai",
  });
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
```

- [ ] **Step 4: Implement the typed configuration module**

Implement these public types and functions in `model-config.ts`:

```ts
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

export function loadModelConfig(environment: NodeJS.ProcessEnv): ModelConfig;
export function buildModelDocument(config: ModelConfig): Record<string, unknown>;
export async function writeModelDocument(agentDir: string, config: ModelConfig): Promise<string>;
```

Use these defaults:

```ts
const defaults = {
  baseUrl: "https://api.kimi.com/coding/v1",
  modelId: "k3-256k",
  contextWindow: 262144,
  reasoningEffort: "high" as const,
  supportsVision: true,
  compatProfile: "kimi" as const,
};
```

Resolve the API key as `LLM_API_KEY?.trim() || KIMI_API_KEY?.trim()` and throw `new Error("LLM_API_KEY or KIMI_API_KEY is required")` when absent. Accept only HTTPS URLs, except `http://127.0.0.1`, `http://localhost`, and `http://[::1]`. Parse booleans only from `true` or `false`; parse context as a positive safe integer. Build the Kimi profile with:

```ts
compat: {
  supportsReasoningEffort: true,
  deferredToolsMode: "kimi",
}
```

Build the OpenAI profile with only:

```ts
compat: { supportsReasoningEffort: true }
```

Write `models.json` atomically by writing `models.json.tmp` with mode `0o600`, then renaming it to `models.json`. Do not include `apiKey` in the JSON document.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
pnpm --filter @ira/chat-backend test -- model-config.test.ts
```

Expected: all model configuration tests PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add apps/chat-backend/src/pi/model-config.ts apps/chat-backend/src/pi/model-config.test.ts
git commit -m "feat: add openai-compatible model configuration"
```

### Task 2: Integrate configuration with pi sessions

**Files:**
- Modify: `apps/chat-backend/src/pi/research-session.ts`
- Modify: `apps/chat-backend/src/research-session.test.ts`
- Modify: `apps/chat-backend/src/chat-registry.ts`
- Modify: `apps/chat-backend/src/routes/chats.test.ts`

- [ ] **Step 1: Write failing integration tests**

Add tests that inject a runtime factory and assert credential/model/session behavior:

```ts
it("configures pi with the selected model and reasoning effort", async () => {
  const setRuntimeApiKey = vi.fn();
  const selectedModel = { provider: "openai-compatible", id: "k3-256k" };
  const runtime = {
    setRuntimeApiKey,
    getModel: vi.fn().mockReturnValue(selectedModel),
  };
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
  expect(createAgentSession.mock.calls[0][0]).toMatchObject({
    model: selectedModel,
    thinkingLevel: "high",
    noTools: "builtin",
  });
});
```

Also assert that a missing API key rejects before `createAgentSession` is called and that the written `models.json` is located in the session-specific `agentDir`.

Update the existing isolation/session tests to pass `environment: { KIMI_API_KEY: "test-key" }` and a runtime mock with `setRuntimeApiKey()` and `getModel()`; tests must never depend on the developer's real environment.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm --filter @ira/chat-backend test -- research-session.test.ts
```

Expected: FAIL because `environment` and `createModelRuntime` are not accepted and `thinkingLevel` is absent.

- [ ] **Step 3: Integrate the model configuration**

Extend `ResearchSessionOptions` with:

```ts
environment?: NodeJS.ProcessEnv;
createModelRuntime?: (options: {
  authPath: string;
  modelsPath: string;
  allowModelNetwork: boolean;
}) => Promise<ModelRuntime>;
```

In `createResearchSession()`:

```ts
const environment = options.environment ?? process.env;
const modelConfig = loadModelConfig(environment);
const modelsPath = await writeModelDocument(agentDir, modelConfig);
const runtimeFactory = options.createModelRuntime ?? ((runtimeOptions) => ModelRuntime.create(runtimeOptions));
const modelRuntime = options.modelRuntime ?? await runtimeFactory({
  authPath: path.join(agentDir, "auth.json"),
  modelsPath,
  allowModelNetwork: false,
});
await modelRuntime.setRuntimeApiKey(modelConfig.providerId, modelConfig.apiKey);
const model = options.model ?? modelRuntime.getModel(modelConfig.providerId, modelConfig.modelId);
if (!model) throw new Error(`Configured model is unavailable: ${modelConfig.modelId}`);
```

Pass `thinkingLevel: modelConfig.reasoningEffort` to `createAgentSession()`. Remove the old `createModelRuntime()` and `selectModel()` environment-selection functions and stop reading `IRA_PI_PROVIDER`, `IRA_PI_MODEL`, and `IRA_PI_API_KEY`.

Preserve the existing `DefaultResourceLoader` isolation and exactly two custom tools.

In `chat-registry.ts`, replace the persisted model expression based on `IRA_PI_MODEL` with:

```ts
const modelId = process.env.LLM_MODEL?.trim() || DEFAULT_MODEL_ID;
```

Pass `modelId` to `researchClient.createRun()`. Add a route/registry test that clears `LLM_MODEL`, expects `k3-256k`, then sets `LLM_MODEL=research-model` and expects the override. Restore the original environment value in `afterEach()`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
pnpm --filter @ira/chat-backend test -- research-session.test.ts model-config.test.ts
```

Expected: both test files PASS, with no network request to Kimi.

- [ ] **Step 5: Run backend regression tests**

Run:

```bash
pnpm --filter @ira/chat-backend test
pnpm --filter @ira/chat-backend typecheck
```

Expected: all backend tests PASS and TypeScript reports no errors.

- [ ] **Step 6: Commit Task 2**

```bash
git add apps/chat-backend/src/pi/research-session.ts apps/chat-backend/src/research-session.test.ts apps/chat-backend/src/chat-registry.ts apps/chat-backend/src/routes/chats.test.ts
git commit -m "feat: configure pi from openai-compatible endpoint"
```

### Task 3: Document startup and verify the complete project

**Files:**
- Modify: `README.md`
- Modify: `scripts/dev-v1a.sh`

- [ ] **Step 1: Write a failing script check**

Add a shell-level test command to the plan execution notes and run the development script without either key:

```bash
env -u LLM_API_KEY -u KIMI_API_KEY bash scripts/dev-v1a.sh
```

Expected: the current script starts child processes instead of failing immediately with a model-key message.

- [ ] **Step 2: Add fail-fast key validation to the development script**

Add this before starting child processes:

```bash
if [[ -z "${LLM_API_KEY:-}" && -z "${KIMI_API_KEY:-}" ]]; then
  echo "Set KIMI_API_KEY for the default Kimi endpoint, or LLM_API_KEY for an override." >&2
  exit 1
fi
```

Do not print either key.

- [ ] **Step 3: Document the default and override workflows**

Add these exact startup examples to `README.md`:

```bash
export KIMI_API_KEY='your-secret-key'
pnpm dev:v1a
```

and:

```bash
export LLM_API_KEY='your-secret-key'
export LLM_BASE_URL='https://llm.example.com/v1'
export LLM_MODEL='research-model'
export LLM_CONTEXT_LENGTH='131072'
export LLM_REASONING_EFFORT='medium'
export LLM_SUPPORTS_VISION='false'
export LLM_COMPAT_PROFILE='openai'
pnpm dev:v1a
```

State that secrets must not be committed to `.env`, `models.json`, logs, or browser code, and that the Web UI remains text-only.

- [ ] **Step 4: Verify fail-fast behavior**

Run:

```bash
env -u LLM_API_KEY -u KIMI_API_KEY bash scripts/dev-v1a.sh
```

Expected: exit code `1` and the message `Set KIMI_API_KEY` before any server starts.

- [ ] **Step 5: Run complete verification without a paid model call**

Run:

```bash
pnpm verify
services/research/.venv/bin/python -m pytest services/research/tests -q
services/research/.venv/bin/ruff check services/research
services/research/.venv/bin/pip install -e 'services/research[dev]'
git diff --check
```

Expected: TypeScript tests, typecheck, Web build, fake-session E2E, 37 Python tests, Ruff, editable install, and diff check all PASS. No command sends a request to Kimi.

- [ ] **Step 6: Commit Task 3**

```bash
git add README.md scripts/dev-v1a.sh
git commit -m "docs: describe openai-compatible model setup"
```

### Task 4: Final security and regression audit

**Files:**
- Review: `apps/chat-backend/src/pi/model-config.ts`
- Review: `apps/chat-backend/src/pi/research-session.ts`
- Review: `apps/chat-backend/src/pi/research-tools.ts`
- Review: `apps/chat-backend/src/research-session.test.ts`
- Review: `README.md`

- [ ] **Step 1: Scan tracked files for credential literals and obsolete variables**

Run:

```bash
rg -n 'sk-[A-Za-z0-9]|IRA_PI_PROVIDER|IRA_PI_MODEL|IRA_PI_API_KEY' --glob '!pnpm-lock.yaml' .
```

Expected: no credential literal and no runtime use of the obsolete `IRA_PI_*` model variables. Historical design/plan references may be updated if they describe current setup rather than past decisions.

- [ ] **Step 2: Confirm tool and resource isolation tests still pass**

Run:

```bash
pnpm --filter @ira/chat-backend test -- research-session.test.ts
```

Expected: tests prove `noTools: "builtin"`, exactly two custom tools, empty extensions/skills/prompts, isolated session directories, configured model, and high Kimi default reasoning.

- [ ] **Step 3: Confirm the worktree is clean**

Run:

```bash
git status --short
```

Expected: no output after all task commits.
