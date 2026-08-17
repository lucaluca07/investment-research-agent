# AG-UI Protocol and Durable Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the V1a chat protocol with a persisted AG-UI 0.0.57 runtime that supports replay, cancellation, standard Interrupt/Resume, and deterministic Pi recovery.

**Architecture:** CopilotKit Runtime 1.68.1 proxies a server-side `PersistentResearchAgent` to Fastify. Fastify converts Pi events to AG-UI, batches text deltas, and persists every event through the Python/DuckDB single writer before emission. Approval state, tool side effects, resume receipts, and Pi checkpoints are durable domain objects.

**Tech Stack:** Node 24, TypeScript 5.9, Fastify 5, CopilotKit Runtime 1.68.1, AG-UI 0.0.57, Pi 0.84.2, Python 3.14, FastAPI, DuckDB, Vitest, pytest.

---

## File map

- `apps/copilot-runtime/src/server.ts`: self-hosted Runtime HTTP entrypoint.
- `apps/copilot-runtime/src/persistent-research-agent.ts`: `AbstractAgent` transport/reconnect adapter.
- `apps/chat-backend/src/ag-ui/pi-event-adapter.ts`: pure Pi-to-AG-UI mapping.
- `apps/chat-backend/src/ag-ui/event-writer.ts`: per-thread serialization and text batching.
- `apps/chat-backend/src/ag-ui/run-controller.ts`: Run, stop, interrupt, resume, and Pi lifecycle.
- `apps/chat-backend/src/routes/agent.ts`: standard AG-UI run/connect/stop endpoints.
- `apps/chat-backend/src/routes/threads.ts`: Thread snapshot/event control plane.
- `services/research/research_service/agui_store.py`: event log, snapshots, and atomic Run creation.
- `services/research/research_service/interrupts.py`: approval, operation, receipt, and checkpoint state machines.
- `services/research/research_service/schema.sql`: replacement development schema.
- Existing `chat_messages`, custom chat events, and `/v1/chats/*/messages` remain temporarily readable by the old path and are removed only after the new E2E passes. New AG-UI code never writes them, so there is no protocol double-write.

### Task 1: Pin protocol dependencies and prove Runtime compatibility

**Files:**
- Modify: `pnpm-workspace.yaml`
- Modify: `package.json`
- Create: `apps/copilot-runtime/package.json`
- Create: `apps/copilot-runtime/tsconfig.json`
- Create: `apps/copilot-runtime/src/compatibility.test.ts`

- [ ] **Step 1: Write the failing compatibility test**

Create a test that constructs `RunFinishedEventSchema` with an interrupt and `RunAgentInputSchema` with a resume:

```ts
expect(RunFinishedEventSchema.parse({
  type: EventType.RUN_FINISHED,
  threadId: "thread-1",
  runId: "run-1",
  outcome: { type: "interrupt", interrupts: [{ id: "i-1", reason: "tool_call", toolCallId: "tc-1" }] },
}).outcome?.type).toBe("interrupt");

expect(RunAgentInputSchema.parse({
  threadId: "thread-1", runId: "run-2", state: {}, messages: [], tools: [], context: [], forwardedProps: {},
  resume: [{ interruptId: "i-1", status: "resolved", payload: { approved: true } }],
}).resume).toHaveLength(1);
```

- [ ] **Step 2: Run the test and verify dependency resolution fails**

Run: `pnpm --filter @ira/copilot-runtime test`

Expected: FAIL because the workspace/package and AG-UI imports do not exist.

- [ ] **Step 3: Add the workspace and exact dependencies**

Add `packages/*` to `pnpm-workspace.yaml`; create `@ira/copilot-runtime` with exact dependencies `@copilotkit/runtime: 1.68.1`, `@ag-ui/client: 0.0.57`, `@ag-ui/core: 0.0.57`, plus `tsx`, `typescript`, and `vitest` scripts consistent with existing apps.

- [ ] **Step 4: Install and verify the compatibility test**

Run: `corepack pnpm install && pnpm --filter @ira/copilot-runtime test && pnpm --filter @ira/copilot-runtime typecheck`

Expected: PASS; lockfile resolves CopilotKit 1.68.1 with AG-UI 0.0.57.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml apps/copilot-runtime
git commit -m "build: pin AG-UI runtime dependencies"
```

### Task 2: Replace the development persistence schema

**Files:**
- Modify: `services/research/research_service/schema.sql`
- Modify: `services/research/research_service/models.py`
- Modify: `services/research/research_service/db.py`
- Create: `services/research/tests/test_agui_schema.py`
- Create: `scripts/reset-dev-db.sh`
- Modify: `package.json`

- [ ] **Step 1: Write schema contract tests**

Assert the migration schema contains `threads`, `runs`, `agui_events`, `message_snapshots`, `tool_calls`, `tool_operations`, `agent_checkpoints`, and `resume_receipts`. Legacy `chats`, `chat_messages`, and `chat_events` remain temporarily for the still-running V1a path and are marked for Task 9 removal. Insert invalid Run/Step/Operation statuses and expect DuckDB constraint errors.

- [ ] **Step 2: Run the schema test and verify failure**

Run: `services/research/.venv/bin/pytest services/research/tests/test_agui_schema.py -q`

Expected: FAIL because the new tables and statuses do not exist.

- [ ] **Step 3: Define the new schema and dataclasses without changing legacy tables yet**

Use these status sets exactly:

```python
RunStatus = Literal["pending", "running", "completed", "interrupted", "failed", "cancelled"]
StepStatus = Literal["pending", "running", "succeeded", "failed", "waiting_approval", "interrupted", "cancelled"]
OperationStatus = Literal["proposed", "waiting_approval", "approved", "executing", "succeeded", "failed", "rejected", "cancelled"]
```

Give events primary key `(thread_id, sequence)`, Runs unique `(thread_id, idempotency_key)`, receipts unique `(thread_id, interrupt_id, status, payload_hash)`, and operations unique `idempotency_key`.

- [ ] **Step 4: Add an explicit safe reset command**

`scripts/reset-dev-db.sh` must resolve the configured path, reject empty paths and directories, require the filename `research.duckdb`, require it to be under the repository `.ira-runtime` directory, and then remove only that file. Add `db:reset:dev` to the root scripts. Normal startup must report an incompatible schema rather than deleting it.

- [ ] **Step 5: Run schema and safety tests**

Run: `services/research/.venv/bin/pytest services/research/tests/test_agui_schema.py services/research/tests/test_workspace.py -q`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/research/research_service/schema.sql services/research/research_service/models.py services/research/research_service/db.py services/research/tests/test_agui_schema.py scripts/reset-dev-db.sh package.json
git commit -m "feat: add durable AG-UI persistence schema"
```

### Task 3: Implement the atomic Run and event store

**Files:**
- Create: `services/research/research_service/agui_store.py`
- Create: `services/research/tests/test_agui_store.py`
- Modify: `services/research/research_service/app.py`
- Modify: `apps/chat-backend/src/research-client.ts`
- Create: `apps/chat-backend/src/research-client.test.ts`

- [ ] **Step 1: Write failing atomicity and idempotency tests**

Test `create_run_with_input()` creates one Run, one `RUN_STARTED` containing normalized input, and one `MESSAGES_SNAPSHOT`. Repeating the same key returns the same Run and sequence; changing the input with the same key raises a conflict. Test `append_events()` allocates contiguous per-thread sequences in one transaction.

- [ ] **Step 2: Run the tests and verify failure**

Run: `services/research/.venv/bin/pytest services/research/tests/test_agui_store.py -q`

Expected: FAIL because `AguiStore` is missing.

- [ ] **Step 3: Implement the minimal store API**

Expose Python methods and FastAPI routes for:

```text
POST /v1/threads
GET  /v1/threads
POST /v1/threads/{thread_id}/runs
POST /v1/threads/{thread_id}/events:batch
GET  /v1/threads/{thread_id}/events?after={sequence}
GET  /v1/threads/{thread_id}/state
POST /v1/runs/{run_id}/transition
```

`create_run_with_input` must canonicalize JSON before hashing and return `{run, replayed, last_event_seq}`.

- [ ] **Step 4: Add typed ResearchClient methods**

Define `AguiEvent`, `ThreadState`, `CreateRunRequest`, and `CreateRunResult`; parse all boundary responses and reject invalid sequence or lifecycle types.

- [ ] **Step 5: Run Python and TypeScript tests**

Run: `services/research/.venv/bin/pytest services/research/tests/test_agui_store.py -q && pnpm --filter @ira/chat-backend test && pnpm --filter @ira/chat-backend typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/research/research_service/agui_store.py services/research/research_service/app.py services/research/tests/test_agui_store.py apps/chat-backend/src/research-client.ts apps/chat-backend/src/research-client.test.ts
git commit -m "feat: persist AG-UI runs and events atomically"
```

### Task 4: Build the Pi event adapter and ordered EventWriter

**Files:**
- Create: `apps/chat-backend/src/ag-ui/pi-event-adapter.ts`
- Create: `apps/chat-backend/src/ag-ui/pi-event-adapter.test.ts`
- Create: `apps/chat-backend/src/ag-ui/event-writer.ts`
- Create: `apps/chat-backend/src/ag-ui/event-writer.test.ts`

- [ ] **Step 1: Write failing pure mapping tests**

Cover text start/content/end with one stable Message ID, Tool Start/Args/End/Result ordering, Step events, unknown Pi events ignored, and malformed known events rejected.

- [ ] **Step 2: Write failing batching tests with fake timers**

Verify text flushes at 50ms or 2KB; a Tool/State/Run event flushes pending text first; two concurrent writes for one Thread reach `appendEventBatch` in sequence; persistence rejection emits nothing.

- [ ] **Step 3: Run tests and verify failure**

Run: `pnpm --filter @ira/chat-backend test -- pi-event-adapter.test.ts event-writer.test.ts`

Expected: FAIL because both modules are missing.

- [ ] **Step 4: Implement pure adapter and writer**

Use only `EventType` and event types imported from `@ag-ui/core`. `EventWriter.write(event)` must serialize by Thread; only `TEXT_MESSAGE_CONTENT` may wait in the batch. `flush()` must complete before non-text persistence and before close.

- [ ] **Step 5: Run focused and package tests**

Run: `pnpm --filter @ira/chat-backend test && pnpm --filter @ira/chat-backend typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/chat-backend/src/ag-ui
git commit -m "feat: adapt Pi events to ordered AG-UI streams"
```

### Task 5: Implement standard Fastify Agent endpoints and cancellation

**Files:**
- Create: `apps/chat-backend/src/ag-ui/run-controller.ts`
- Create: `apps/chat-backend/src/ag-ui/run-controller.test.ts`
- Create: `apps/chat-backend/src/routes/agent.ts`
- Create: `apps/chat-backend/src/routes/agent.test.ts`
- Modify: `apps/chat-backend/src/app.ts`

- [ ] **Step 1: Write failing Run lifecycle tests**

Assert the first event is `RUN_STARTED`; success ends with `RUN_FINISHED { outcome: { type: "success" } }`; model failure ends with `RUN_ERROR`; stop aborts Pi, persists `cancelled`, and ends with `RUN_ERROR { code: "run_cancelled" }` which the test treats as non-retryable.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm --filter @ira/chat-backend test -- run-controller.test.ts agent.test.ts`

Expected: FAIL because the controller and routes are missing.

- [ ] **Step 3: Implement the controller**

Allow one active Run per Thread. Persist `RUN_STARTED` before prompting Pi, subscribe before prompt, pass every converted event through `EventWriter`, flush in `finally`, and never broadcast an event that failed persistence.

- [ ] **Step 4: Implement routes**

Expose standard POST Run SSE, GET control-plane replay/state endpoints, and explicit Stop. Bind only to loopback through the existing server configuration.

- [ ] **Step 5: Run backend tests**

Run: `pnpm --filter @ira/chat-backend test && pnpm --filter @ira/chat-backend typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/chat-backend/src/ag-ui/run-controller.ts apps/chat-backend/src/ag-ui/run-controller.test.ts apps/chat-backend/src/routes/agent.ts apps/chat-backend/src/routes/agent.test.ts apps/chat-backend/src/app.ts
git commit -m "feat: expose persisted AG-UI agent runs"
```

### Task 6: Add Copilot Runtime and reconnect transport

**Files:**
- Create: `apps/copilot-runtime/src/persistent-research-agent.ts`
- Create: `apps/copilot-runtime/src/persistent-research-agent.test.ts`
- Create: `apps/copilot-runtime/src/server.ts`
- Create: `apps/copilot-runtime/src/server.test.ts`
- Modify: `scripts/dev-v1a.sh`

- [ ] **Step 1: Write failing Agent contract tests**

Test `protected run(input)` proxies the Fastify Run stream, `connect(input)` loads state and replays after the cursor without duplicates, `abortRun()` calls Stop, and `getCapabilities()` declares streaming, resumable, snapshots, approvals, and interrupts.

- [ ] **Step 2: Write the Runtime discovery test**

Start the Runtime handler with the Agent registered as `research-agent`; assert `/info` discovers it and `/agent/research-agent/run` preserves an interrupt outcome.

- [ ] **Step 3: Run tests and verify failure**

Run: `pnpm --filter @ira/copilot-runtime test`

Expected: FAIL because the Agent and server are missing.

- [ ] **Step 4: Implement the Runtime service**

Use the v2 Runtime handler, not legacy v1 factories. The Agent must clone request-local state, but store no messages. Forward authorization and `x-ira-*` headers only; use loopback Fastify URL from validated configuration.

- [ ] **Step 5: Update the portable development script**

Start Python, Fastify, Runtime, and Vite with explicit ports and the existing Bash 3.2-compatible child cleanup. Wait for each health endpoint before reporting ready.

- [ ] **Step 6: Verify Runtime and startup tests**

Run: `pnpm --filter @ira/copilot-runtime test && pnpm --filter @ira/copilot-runtime typecheck && pnpm --filter @ira/chat-backend test -- dev-script.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/copilot-runtime scripts/dev-v1a.sh
git commit -m "feat: proxy research runs through Copilot Runtime"
```

### Task 7: Implement durable Interrupt, operation, receipt, and checkpoint state

**Files:**
- Create: `services/research/research_service/interrupts.py`
- Create: `services/research/tests/test_interrupts.py`
- Modify: `services/research/research_service/app.py`
- Modify: `services/research/research_service/tools.py`
- Modify: `apps/chat-backend/src/research-client.ts`

- [ ] **Step 1: Write failing state-machine tests**

Cover `waiting_approval → approved → executing → succeeded`, rejection, cancellation, conflicting second decisions returning conflict, identical resume replay returning the original receipt, and uncertain `executing` requiring manual review.

- [ ] **Step 2: Write failing transaction fault tests**

Inject a failure after Approval update and assert Approval, Operation, and Receipt all roll back. Inject a failure after note insert and assert the Operation does not report `succeeded`.

- [ ] **Step 3: Run tests and verify failure**

Run: `services/research/.venv/bin/pytest services/research/tests/test_interrupts.py -q`

Expected: FAIL because the interrupt store is missing.

- [ ] **Step 4: Implement `request_interrupt` and `resolve_interrupt`**

`resolve_interrupt(thread_id, interrupt_id, nonce, status, payload, payload_hash)` must validate all open interrupts, validate `{ approved: boolean }` for resolved payloads, atomically update domain rows, and return a normalized result containing Operation and Checkpoint IDs.

- [ ] **Step 5: Expose typed endpoints and client methods**

Add only server-to-server Research Service routes. Never expose direct “execute note” from the browser. Return `409` for conflicting decisions and `422` for invalid schema/nonce.

- [ ] **Step 6: Run research and backend tests**

Run: `services/research/.venv/bin/pytest services/research/tests/test_interrupts.py services/research/tests/test_tool_api.py -q && pnpm --filter @ira/chat-backend test`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add services/research/research_service/interrupts.py services/research/research_service/app.py services/research/research_service/tools.py services/research/tests/test_interrupts.py apps/chat-backend/src/research-client.ts
git commit -m "feat: persist interrupt decisions and tool operations"
```

### Task 8: Implement Pi checkpoint and Resume control

**Files:**
- Modify: `apps/chat-backend/src/pi/research-session.ts`
- Modify: `apps/chat-backend/src/pi/research-session.test.ts`
- Create: `apps/chat-backend/src/ag-ui/resume-controller.ts`
- Create: `apps/chat-backend/src/ag-ui/resume-controller.test.ts`
- Modify: `apps/chat-backend/src/ag-ui/run-controller.ts`

- [ ] **Step 1: Write failing normal-resume tests**

Given an interrupt checkpoint and approved receipt, assert Resume restores the recorded Pi Session revision, verifies the original Tool Call mapping, executes the operation once, emits `TOOL_CALL_RESULT` against the old ID without repeating Start/Args/End, and continues the Pi Turn.

- [ ] **Step 2: Write failing fallback tests**

Delete or corrupt the fake Pi Session. Assert Resume creates a `recovery_fallback` Turn containing the original messages, Tool Call, decision, and deterministic result; assert an already-succeeded operation is not executed again.

- [ ] **Step 3: Run focused tests and verify failure**

Run: `pnpm --filter @ira/chat-backend test -- resume-controller.test.ts research-session.test.ts`

Expected: FAIL because checkpoint restoration is missing.

- [ ] **Step 4: Expose validated Pi session metadata**

Return `sessionId`, revision, and repository-relative session storage reference from the session factory. Reject checkpoint paths outside `.ira-runtime/sessions`; never persist an arbitrary absolute path supplied by a client.

- [ ] **Step 5: Implement Resume controller**

Read Checkpoint before resolving, call the atomic Research Service command, process Operation state deterministically, then restore/inject. A Resume request must cover every open Interrupt; ordinary input while one is open yields `RUN_ERROR`.

- [ ] **Step 6: Run backend tests**

Run: `pnpm --filter @ira/chat-backend test && pnpm --filter @ira/chat-backend typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/chat-backend/src/pi/research-session.ts apps/chat-backend/src/pi/research-session.test.ts apps/chat-backend/src/ag-ui/resume-controller.ts apps/chat-backend/src/ag-ui/resume-controller.test.ts apps/chat-backend/src/ag-ui/run-controller.ts
git commit -m "feat: resume interrupted Pi research runs"
```

### Task 9: Replace V1a E2E and remove the old protocol

**Files:**
- Create: `tests/e2e/ag-ui-runtime.test.ts`
- Modify: `tests/e2e/fake-agent-session.ts`
- Delete: `tests/e2e/v1a-chat.test.ts`
- Delete: `apps/chat-backend/src/chat-registry.ts`
- Delete: `apps/chat-backend/src/routes/chats.ts`
- Modify: `apps/chat-backend/src/app.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the new failing process-boundary E2E**

Cover Runtime discovery, persisted streaming, reconnect after cursor, duplicate request idempotency, Stop as `run_cancelled`, approval interrupt, approve/reject/cancel, complete Python/Fastify/Runtime restart before resume, and corrupt Pi Session fallback.

- [ ] **Step 2: Run E2E and verify failure**

Run: `pnpm vitest run tests/e2e/ag-ui-runtime.test.ts`

Expected: FAIL until all new boundaries are wired.

- [ ] **Step 3: Wire the new E2E fixtures and make it pass**

Use a temporary DuckDB file and temporary `.ira-runtime`, dynamically allocated loopback ports, and explicit child shutdown. Assert event IDs are monotonic and each Assistant Message ID renders once.

- [ ] **Step 4: Delete the old backend protocol**

Remove custom `message.delta`, `message.completed`, `run.status`, `ChatRegistry`, old message endpoints, old E2E, and the legacy `chats`, `chat_messages`, and `chat_events` tables. Keep no compatibility double-write or legacy read path.

- [ ] **Step 5: Run full Phase 1 verification**

Run: `services/research/.venv/bin/pytest services/research/tests -q && pnpm test && pnpm typecheck && pnpm vitest run tests/e2e/ag-ui-runtime.test.ts`

Expected: all commands exit 0 with no failed tests.

- [ ] **Step 6: Commit**

```bash
git add -A apps/chat-backend tests/e2e package.json services/research
git commit -m "refactor: replace V1a chat protocol with AG-UI"
```
