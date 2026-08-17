# Investment Research Agent V1a

V1a is a local-only research chat. The Chat Backend embeds the pi session and
uses the loopback Python service as the single writer for DuckDB state.

## Local verification

```bash
pnpm test
pnpm typecheck
pnpm --filter @ira/web build
pnpm test:e2e
```

The optional `pnpm dev:v1a` script starts the Python service, Chat Backend,
and Web dev server on loopback addresses. It traps termination and cleans up
all child processes.

To validate credentials and profile selection without starting any service:

```bash
bash scripts/dev-v1a.sh --validate-credentials
```

## Model configuration

By default, the local stack uses the Kimi Coding Plan endpoint and `k3-256k`.
Set the Kimi key before startup:

```bash
export KIMI_API_KEY='your-secret-key'
pnpm dev:v1a
```

For another OpenAI-compatible endpoint, use the override configuration:

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

Never commit secrets or put them in `.env`, `models.json`, logs, or browser
code. The Web UI remains text-only and does not contain provider credentials.
