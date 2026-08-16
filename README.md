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
