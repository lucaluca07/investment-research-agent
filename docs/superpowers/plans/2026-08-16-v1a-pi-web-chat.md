# V1a pi Web Research Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Web chat that uses pi to answer one Victory Giant Technology (胜宏科技) PCB research question through allowlisted Python/DuckDB tools with streaming, citations, durable run steps, and crash-safe idempotency.

**Architecture:** A React browser connects only to a TypeScript Chat Backend. The backend embeds `@earendil-works/pi-coding-agent` directly, disables pi built-in tools, exposes two custom research tools, and streams normalized UI events over SSE. A single-process FastAPI service is the only process allowed to open DuckDB or Parquet and persists chats, runs, steps, citations, and idempotent research notes.

**Tech Stack:** Node.js 24, pnpm 11, TypeScript, Fastify, React, Vite, Vitest, pi SDK `0.84.2`, Python 3.14, FastAPI, Pydantic, DuckDB, pytest, Ruff.

---

## Scope and file map

This plan implements V1a only. V1b continuous tracking and V1c weekly review/workbench require separate plans after the V1a exit tests pass.

Files and responsibilities:

- `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`: JavaScript workspace and shared compiler settings.
- `apps/chat-backend/src/app.ts`: Fastify composition and route registration.
- `apps/chat-backend/src/pi/research-session.ts`: pi session construction, built-in-tool denial, event subscription, and lifecycle.
- `apps/chat-backend/src/pi/research-tools.ts`: allowlisted pi tools backed only by the Python service.
- `apps/chat-backend/src/research-client.ts`: typed HTTP client for the Python service.
- `apps/chat-backend/src/routes/chats.ts`: chat creation, prompting, stopping, history, and SSE endpoints.
- `apps/chat-backend/src/chat-registry.ts`: one active pi session and one active run per chat.
- `apps/web/src/App.tsx`: V1a chat shell.
- `apps/web/src/lib/chat-api.ts`: backend HTTP/SSE client.
- `services/research/pyproject.toml`: Python dependencies and tool configuration.
- `services/research/research_service/app.py`: FastAPI composition.
- `services/research/research_service/db.py`: sole DuckDB connection owner and transaction helper.
- `services/research/research_service/schema.sql`: V1a tables.
- `services/research/research_service/runs.py`: `ResearchRun` and `ResearchRunStep` state transitions.
- `services/research/research_service/tools.py`: company snapshot and idempotent note operations.
- `services/research/research_service/models.py`: request/response models.
- `services/research/tests/`: storage, transition, API, idempotency, and single-writer tests.
- `tests/e2e/v1a-chat.test.ts`: browser-to-tool vertical-path test with controlled model events.

### Task 1: Scaffold the V1a workspace

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `apps/chat-backend/package.json`
- Create: `apps/chat-backend/tsconfig.json`
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `services/research/pyproject.toml`
- Create: `services/research/tests/test_workspace.py`
- Create: `.gitignore`

- [ ] **Step 1: Add a failing workspace smoke check**

Create `apps/chat-backend/src/workspace.test.ts`:

```ts
import { describe, expect, it } from "vitest";

describe("workspace", () => {
  it("runs TypeScript tests", () => expect(true).toBe(true));
});
```

Create `services/research/tests/test_workspace.py`:

```python
def test_python_test_runtime() -> None:
    assert True
```

- [ ] **Step 2: Run the smoke check and verify the workspace is not configured**

Run: `pnpm --filter @ira/chat-backend test`

Expected: FAIL because the workspace and package manifests do not exist.

- [ ] **Step 3: Add the workspace manifests**

Use these root scripts and pin pi to the verified SDK version:

```json
{
  "name": "investment-research-agent",
  "private": true,
  "packageManager": "pnpm@11.5.1",
  "scripts": {
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck"
  },
  "devDependencies": {
    "typescript": "^5.9.2",
    "vitest": "4.1.10"
  }
}
```

```yaml
packages:
  - apps/*
```

Use this Chat Backend manifest:

```json
{
  "name": "@ira/chat-backend",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@earendil-works/pi-coding-agent": "0.84.2",
    "fastify": "5.12.0",
    "typebox": "1.3.14"
  },
  "devDependencies": {
    "tsx": "4.23.12"
  }
}
```

Use this Web manifest:

```json
{
  "name": "@ira/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "build": "vite build"
  },
  "dependencies": {
    "react": "19.2.8",
    "react-dom": "19.2.8"
  },
  "devDependencies": {
    "@testing-library/react": "16.3.2",
    "@testing-library/user-event": "14.6.4",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "6.0.5",
    "jsdom": "30.0.1",
    "vite": "8.2.1"
  }
}
```

Use a `pyproject.toml` requiring Python `>=3.14` with runtime dependencies `fastapi`, `uvicorn`, `duckdb`, and `pydantic`, plus a `dev` extra containing `pytest`, `httpx`, and `ruff`.

- [ ] **Step 4: Install dependencies and verify both runtimes**

Run: `pnpm install && python3 -m venv services/research/.venv && services/research/.venv/bin/pip install -e 'services/research[dev]'`

Expected: both commands exit 0 and `pnpm-lock.yaml` is created.

- [ ] **Step 5: Run the workspace checks**

Run: `pnpm --filter @ira/chat-backend test && services/research/.venv/bin/pytest services/research/tests -q`

Expected: TypeScript and Python smoke tests both report one passing test.

- [ ] **Step 6: Commit the scaffold**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json apps services .gitignore
git commit -m "chore: scaffold v1a workspace"
```

### Task 2: Implement the single-writer DuckDB store

**Files:**
- Create: `services/research/research_service/__init__.py`
- Create: `services/research/research_service/db.py`
- Create: `services/research/research_service/schema.sql`
- Create: `services/research/research_service/models.py`
- Create: `services/research/research_service/runs.py`
- Create: `services/research/tests/test_runs.py`

- [ ] **Step 1: Write failing state-transition tests**

```python
def test_waiting_approval_can_resume_or_cancel(store):
    run = store.create_run(chat_id="chat-1", pi_session_id="pi-1", model="test/model")
    step = store.start_step(run.id, "save_note", "key-1", "sha256:abc")
    store.request_approval(step.id, {"note": "draft"})
    assert store.get_step(step.id).status == "waiting_approval"
    store.approve(step.id, actor="local-user")
    assert store.get_step(step.id).status == "running"


def test_succeeded_step_returns_original_result_for_same_idempotency_key(store):
    run = store.create_run(chat_id="chat-1", pi_session_id="pi-1", model="test/model")
    first = store.start_step(run.id, "save_note", "stable-key", "sha256:abc")
    store.succeed(first.id, {"note_id": "note-1"})
    replay = store.start_step(run.id, "save_note", "stable-key", "sha256:abc")
    assert replay.id == first.id
    assert replay.result == {"note_id": "note-1"}
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `services/research/.venv/bin/pytest services/research/tests/test_runs.py -v`

Expected: FAIL because `RunStore` and the schema do not exist.

- [ ] **Step 3: Add the schema**

Create tables `chats`, `research_runs`, `research_run_steps`, `approval_requests`, `research_notes`, and `citations`. Enforce `UNIQUE(run_id, idempotency_key)` on steps and use explicit status `CHECK` constraints.

```sql
CREATE TABLE research_run_steps (
  id VARCHAR PRIMARY KEY,
  run_id VARCHAR NOT NULL,
  step_name VARCHAR NOT NULL,
  status VARCHAR NOT NULL CHECK (status IN ('pending','running','succeeded','failed','waiting_approval','cancelled')),
  idempotency_key VARCHAR NOT NULL,
  input_hash VARCHAR NOT NULL,
  pi_message_id VARCHAR,
  pi_tool_call_id VARCHAR,
  result_json JSON,
  error_json JSON,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  UNIQUE(run_id, idempotency_key)
);
```

- [ ] **Step 4: Implement a process-owned connection and transition guards**

`Database` creates one DuckDB connection during FastAPI lifespan and exposes `transaction()`. `RunStore` rejects illegal transitions and treats an existing succeeded idempotency key as a replay returning the saved result. Do not expose database paths through API models.

- [ ] **Step 5: Run storage tests**

Run: `services/research/.venv/bin/pytest services/research/tests/test_runs.py -v`

Expected: all transition and replay tests pass.

- [ ] **Step 6: Commit the store**

```bash
git add services/research/research_service services/research/tests/test_runs.py
git commit -m "feat: add durable research run store"
```

### Task 3: Expose constrained Python research tools

**Files:**
- Create: `services/research/research_service/app.py`
- Create: `services/research/research_service/tools.py`
- Create: `services/research/tests/test_tool_api.py`
- Create: `services/research/tests/fixtures/shenghong_snapshot.json`

- [ ] **Step 1: Write failing API tests**

```python
def test_company_snapshot_returns_dated_citations(client):
    response = client.post("/v1/tools/query-company-snapshot", json={"ticker": "300476.SZ"})
    assert response.status_code == 200
    body = response.json()
    assert body["company_name"] == "胜宏科技"
    assert body["as_of_date"] == "2026-08-14"
    assert body["citations"][0]["document_id"] == "fixture:300476:2026-08-14"


def test_save_note_replays_original_result(client, run_id):
    request = {
        "run_id": run_id,
        "idempotency_key": "run-1:save-note:sha256-abc",
        "title": "PCB exposure",
        "body": "Evidence-backed draft",
        "citation_ids": ["fixture:300476:2026-08-14"],
    }
    first = client.post("/v1/tools/save-research-note", json=request)
    second = client.post("/v1/tools/save-research-note", json=request)
    assert first.json() == second.json()
```

- [ ] **Step 2: Verify the API tests fail**

Run: `services/research/.venv/bin/pytest services/research/tests/test_tool_api.py -v`

Expected: FAIL with missing FastAPI app/routes.

- [ ] **Step 3: Implement the read tool and immutable fixture citation**

The snapshot endpoint accepts only ticker `300476.SZ` in V1a. It returns `company_name`, `ticker`, `as_of_date`, structured metrics, and citations containing `document_id`, `title`, `published_at`, and `locator`. Unknown tickers return HTTP 422.

Also expose application-state endpoints used by Chat Backend: `POST /v1/chats`, `GET /v1/chats/{chat_id}/messages`, `POST /v1/research-runs`, and `PATCH /v1/chats/{chat_id}/pi-session`. These endpoints persist through `RunStore`; they never return the DuckDB path.

- [ ] **Step 4: Implement the idempotent write tool**

`save-research-note` validates citation IDs, starts or replays a `ResearchRunStep`, writes the note and result in one DuckDB transaction, and marks the step succeeded. A test-only fault hook raises after note insertion but before commit; retry must create exactly one note.

- [ ] **Step 5: Run API and lint checks**

Run: `services/research/.venv/bin/pytest services/research/tests -v && services/research/.venv/bin/ruff check services/research`

Expected: all tests pass and Ruff reports no errors.

- [ ] **Step 6: Commit the research API**

```bash
git add services/research
git commit -m "feat: expose constrained research tools"
```

### Task 4: Embed pi with a strict production tool allowlist

**Files:**
- Create: `apps/chat-backend/src/research-client.ts`
- Create: `apps/chat-backend/src/pi/research-tools.ts`
- Create: `apps/chat-backend/src/pi/research-session.ts`
- Create: `apps/chat-backend/src/pi/research-session.test.ts`

- [ ] **Step 1: Write the failing tool-isolation test**

```ts
it("creates a production session without pi built-ins", async () => {
  await createResearchSession(deps);
  expect(deps.createAgentSession).toHaveBeenCalledWith(
    expect.objectContaining({
      noTools: "builtin",
      customTools: expect.arrayContaining([
        expect.objectContaining({ name: "query_company_snapshot" }),
        expect.objectContaining({ name: "save_research_note" }),
      ]),
    }),
  );
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm --filter @ira/chat-backend test -- research-session.test.ts`

Expected: FAIL because `createResearchSession` does not exist.

- [ ] **Step 3: Implement typed Python-service calls**

`ResearchClient` receives a fixed localhost base URL and exposes only `createRun`, `queryCompanySnapshot`, `saveResearchNote`, and `getChatHistory`. Reject non-loopback URLs at startup in V1a.

- [ ] **Step 4: Define the two pi tools**

Use pi's `defineTool()` and TypeBox schemas. Tool `execute` methods call `ResearchClient`; they never import filesystem, child-process, DuckDB, or Parquet modules.

```ts
const queryCompanySnapshot = defineTool({
  name: "query_company_snapshot",
  label: "Query company snapshot",
  description: "Return dated, cited metrics for the V1a company.",
  parameters: Type.Object({ ticker: Type.Literal("300476.SZ") }),
  execute: async (_callId, params) => ({
    content: [{ type: "text", text: JSON.stringify(await client.queryCompanySnapshot(params)) }],
    details: {},
  }),
});
```

- [ ] **Step 5: Construct the production pi session**

Call `createAgentSession()` with `noTools: "builtin"`, exactly the two custom tools, an app-owned session directory, a Research Lead system prompt, and pi SDK `0.84.2`. Point `DefaultResourceLoader` at an app-owned empty `cwd` and empty `agentDir`, use `SettingsManager.inMemory()`, and inject model credentials through `ModelRuntime`; this prevents discovery of user-global or project extensions, skills, prompts, settings, and `AGENTS.md` files.

- [ ] **Step 6: Run isolation and type checks**

Run: `pnpm --filter @ira/chat-backend test -- research-session.test.ts && pnpm --filter @ira/chat-backend typecheck`

Expected: tests pass and TypeScript reports no errors.

- [ ] **Step 7: Commit the pi integration**

```bash
git add apps/chat-backend
git commit -m "feat: embed pi with research-only tools"
```

### Task 5: Add chat lifecycle and SSE streaming

**Files:**
- Create: `apps/chat-backend/src/chat-registry.ts`
- Create: `apps/chat-backend/src/routes/chats.ts`
- Create: `apps/chat-backend/src/app.ts`
- Create: `apps/chat-backend/src/server.ts`
- Create: `apps/chat-backend/src/routes/chats.test.ts`

- [ ] **Step 1: Write failing route tests**

```ts
it("streams normalized text and tool events", async () => {
  const chat = await api.createChat();
  const events = api.collectEvents(chat.id);
  await api.prompt(chat.id, "胜宏科技的 PCB 业务证据是什么？");
  expect(await events.takeTypes(4)).toEqual([
    "run.started",
    "tool.started",
    "message.delta",
    "run.completed",
  ]);
});

it("rejects a second active run for the same chat", async () => {
  const chat = await api.createChat();
  await api.startBlockedPrompt(chat.id);
  expect((await api.promptRaw(chat.id, "second")).statusCode).toBe(409);
});
```

- [ ] **Step 2: Verify route tests fail**

Run: `pnpm --filter @ira/chat-backend test -- chats.test.ts`

Expected: FAIL because chat routes and registry do not exist.

- [ ] **Step 3: Implement the in-process chat registry**

Track `chatId → { session, unsubscribe, activeRunId, subscribers }`. Permit one active run per chat. On shutdown, unsubscribe and dispose every pi session. Persist chat metadata through `ResearchClient`; do not treat the registry as durable state.

- [ ] **Step 4: Implement the routes**

Add:

- `POST /api/chats`
- `GET /api/chats/:chatId/messages`
- `GET /api/chats/:chatId/events` as `text/event-stream`
- `POST /api/chats/:chatId/prompts`
- `POST /api/chats/:chatId/stop`

Normalize pi events into `run.started`, `message.delta`, `tool.started`, `tool.completed`, `run.failed`, and `run.completed`. Never send model credentials, raw system prompts, database paths, or unrestricted tool arguments to the browser.

- [ ] **Step 5: Run route and type checks**

Run: `pnpm --filter @ira/chat-backend test -- chats.test.ts && pnpm --filter @ira/chat-backend typecheck`

Expected: all route tests pass and TypeScript reports no errors.

- [ ] **Step 6: Commit chat streaming**

```bash
git add apps/chat-backend
git commit -m "feat: stream pi chat events over sse"
```

### Task 6: Build the V1a Web chat

**Files:**
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/lib/chat-api.ts`
- Create: `apps/web/src/components/MessageList.tsx`
- Create: `apps/web/src/components/ResearchTrace.tsx`
- Create: `apps/web/src/components/Composer.tsx`
- Create: `apps/web/src/App.test.tsx`
- Create: `apps/web/src/styles.css`

- [ ] **Step 1: Write the failing UI test**

```tsx
it("renders streaming text, citation, tool status, and stop control", async () => {
  const fakeChatApi = createFakeChatApi([
    { type: "tool.started", label: "正在查询公司快照" },
    { type: "message.delta", delta: "胜宏科技" },
    { type: "citation", title: "公司快照", publishedAt: "2026-08-14", href: "/citations/fixture" },
  ]);
  render(<App api={fakeChatApi} />);
  await userEvent.type(screen.getByRole("textbox"), "研究胜宏科技");
  await userEvent.click(screen.getByRole("button", { name: "发送" }));
  expect(await screen.findByText("正在查询公司快照")).toBeVisible();
  expect(await screen.findByText("胜宏科技")).toBeVisible();
  expect(screen.getByRole("link", { name: /2026-08-14/ })).toBeVisible();
  expect(screen.getByRole("button", { name: "停止" })).toBeVisible();
});
```

- [ ] **Step 2: Run the UI test and verify it fails**

Run: `pnpm --filter @ira/web test -- App.test.tsx`.

Expected: FAIL because the chat components do not exist.

- [ ] **Step 3: Implement the browser client**

`chat-api.ts` creates a chat, opens one `EventSource`, posts prompts, requests stop, and fetches persisted messages after reconnect. Keep the API base URL relative so the local reverse proxy owns host selection.

- [ ] **Step 4: Implement the chat shell**

Render user/assistant messages in the main column. Render citations as links carrying document title, publication date, and locator. Put tool progress and errors in a collapsed `ResearchTrace`; show Stop only while a run is active. Preserve draft text when the connection drops.

- [ ] **Step 5: Run UI tests and build**

Run: `pnpm --filter @ira/web test && pnpm --filter @ira/web typecheck && pnpm --filter @ira/web build`

Expected: tests pass, TypeScript reports no errors, and Vite creates `apps/web/dist`.

- [ ] **Step 6: Commit the Web chat**

```bash
git add apps/web
git commit -m "feat: add v1a research chat ui"
```

### Task 7: Verify crash recovery and the complete V1a path

**Files:**
- Create: `tests/e2e/v1a-chat.test.ts`
- Create: `tests/e2e/fake-agent-session.ts`
- Create: `scripts/dev-v1a.sh`
- Modify: `package.json`
- Create: `README.md`

- [ ] **Step 1: Write the failing vertical-path test**

The test starts the Python service with a temporary DuckDB file and injects `tests/e2e/fake-agent-session.ts` into Chat Backend. The fixture implements only the `prompt`, `subscribe`, `abort`, `dispose`, `sessionId`, and `sessionFile` members consumed by Chat Backend and emits the same pi event shapes used by production without calling a paid model. Start the Python service with `IRA_TEST_MODE=1`, which enables a count-only `/test/research-notes` endpoint for assertions; production startup must reject that route. It sends the fixed Victory Giant question and asserts:

```ts
expect(events.map((event) => event.type)).toContain("message.delta");
expect(finalMessage.citations[0].documentId).toBe("fixture:300476:2026-08-14");
expect(await researchTestApi.countNotes(idempotencyKey)).toBe(1);
expect(exposedToolNames).toEqual(["query_company_snapshot", "save_research_note"]);
```

- [ ] **Step 2: Add the crash-window case**

Terminate Chat Backend after Python reports the write result but before `run.completed`. Restart the backend, reopen the pi session, replay the same step, and assert the note count remains one and the original result reference is returned.

- [ ] **Step 3: Run the end-to-end test and verify it fails before harness wiring**

Run: `pnpm vitest run tests/e2e/v1a-chat.test.ts`

Expected: FAIL because the V1a process harness is not wired.

- [ ] **Step 4: Add the local process harness and run script**

`scripts/dev-v1a.sh` starts exactly one Uvicorn worker bound to `127.0.0.1:8010`, Chat Backend on `127.0.0.1:8020`, and Vite on `127.0.0.1:5173`. It traps exit signals and terminates all three child processes. Add root scripts `dev:v1a`, `test:e2e`, and `verify`.

- [ ] **Step 5: Run full verification**

Run:

```bash
services/research/.venv/bin/ruff check services/research
services/research/.venv/bin/pytest services/research/tests -q
pnpm test
pnpm typecheck
pnpm --filter @ira/web build
pnpm test:e2e
```

Expected: every command exits 0; pytest and Vitest report zero failures; Web build succeeds; crash recovery leaves one note.

- [ ] **Step 6: Document startup and security boundaries**

In `README.md`, document prerequisites, model credential setup, `pnpm dev:v1a`, local URLs, data directory, tool allowlist, Python single-writer rule, and how to run `pnpm verify`. Explicitly state that V1a contains fixture-backed Victory Giant data and is not yet the continuous tracker.

- [ ] **Step 7: Commit V1a verification**

```bash
git add tests scripts package.json README.md
git commit -m "test: verify v1a research chat path"
```

## Plan self-review checklist

- V1a scope only: one company, one research question, two allowlisted tools.
- pi built-ins disabled with the documented `noTools: "builtin"` SDK option.
- Browser never connects to pi or Python directly.
- Python service is the only DuckDB/Parquet accessor and runs with one worker.
- `ResearchRunStep`, approval-compatible states, stable idempotency, and crash recovery are covered.
- Web streaming, stop, history, tool status, and citations are covered.
- No V1b scheduler, five-company tracking, or V1c workbench is pulled into this plan.
