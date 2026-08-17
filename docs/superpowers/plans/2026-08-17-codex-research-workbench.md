# Codex Research Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the prototype page with a Codex-style research workbench backed by CopilotKit v2, persisted AG-UI Threads, native Interrupt approval, and Inspector-based research artifacts.

**Architecture:** The app wraps React in the Runtime-backed CopilotKit provider. Small hooks adapt Agent messages/events and Fastify Thread/Artifact control-plane data into `@ira/ui` view models. DuckDB events remain authoritative; application state holds only current selection, draft input, panel state, and ephemeral connection status.

**Tech Stack:** React 19, Vite 8, CopilotKit React Core 1.68.1, AG-UI 0.0.57, `@ira/ui`, Vitest, Testing Library, Playwright.

---

## File map

- `apps/web/src/providers/research-agent-provider.tsx`: CopilotKit Runtime configuration.
- `apps/web/src/features/threads/*`: Thread control-plane queries and selection.
- `apps/web/src/features/conversation/*`: Agent-to-view-model reducers and conversation rendering.
- `apps/web/src/features/interrupts/*`: `useInterrupt` approval UI and resume submission.
- `apps/web/src/features/inspector/*`: Evidence, Artifact, Tool, and Approval inspectors.
- `apps/web/src/app/research-workbench.tsx`: composition only.
- `apps/web/src/lib/chat-api.ts` and old prototype components are deleted after replacement tests pass.

### Task 1: Configure Runtime-backed CopilotKit and development proxies

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/src/main.tsx`
- Create: `apps/web/src/providers/research-agent-provider.tsx`
- Create: `apps/web/src/providers/research-agent-provider.test.tsx`
- Modify: `apps/web/vite.config.ts`
- Modify: `apps/web/src/dev-proxy.test.ts`

- [ ] **Step 1: Write failing provider/proxy tests**

Assert the provider uses `runtimeUrl="/api/copilotkit"` and agent ID `research-agent`; assert Vite proxies `/api/copilotkit` to Runtime and `/v1` to Fastify, both on loopback targets.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @ira/web test -- research-agent-provider.test.tsx dev-proxy.test.ts`

Expected: FAIL because the provider and Runtime proxy are missing.

- [ ] **Step 3: Add exact dependencies and provider**

Pin `@copilotkit/react-core` to `1.68.1` and `@ag-ui/core` to `0.0.57`. Render:

```tsx
<CopilotKit runtimeUrl="/api/copilotkit" agent="research-agent" showDevConsole={false}>
  {children}
</CopilotKit>
```

Do not enable premium Threads/Inspector features; the application owns those surfaces.

- [ ] **Step 4: Verify**

Run: `corepack pnpm install && pnpm --filter @ira/web test && pnpm --filter @ira/web typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json apps/web/src/main.tsx apps/web/src/providers apps/web/vite.config.ts apps/web/src/dev-proxy.test.ts pnpm-lock.yaml
git commit -m "feat: connect web app to Copilot Runtime"
```

### Task 2: Implement the persisted Thread control plane

**Files:**
- Create: `apps/web/src/features/threads/thread-api.ts`
- Create: `apps/web/src/features/threads/thread-api.test.ts`
- Create: `apps/web/src/features/threads/use-threads.ts`
- Create: `apps/web/src/features/threads/use-threads.test.tsx`

- [ ] **Step 1: Write failing API and hook tests**

Cover list, create, deterministic first-message title, manual rename, selection, loading/error/empty state, and stable ordering by `updated_at`. Assert no automatic title request occurs.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @ira/web test -- thread-api.test.ts use-threads.test.tsx`

Expected: FAIL because Thread modules are missing.

- [ ] **Step 3: Implement typed Thread API**

```ts
export type ThreadSummary = {
  id: string;
  title: string;
  titleSource: "first_message" | "manual";
  updatedAt: string;
  securities: string[];
  runState: "idle" | "running" | "interrupted" | "completed" | "failed" | "cancelled";
};
```

The hook stores selected ID only; server responses remain authoritative. First title is a deterministic Unicode-safe truncation of the first normalized user message.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @ira/web test -- thread-api.test.ts use-threads.test.tsx && pnpm --filter @ira/web typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/threads
git commit -m "feat: add persisted research task navigation"
```

### Task 3: Adapt CopilotKit Agent state into the conversation timeline

**Files:**
- Create: `apps/web/src/features/conversation/agent-view-model.ts`
- Create: `apps/web/src/features/conversation/agent-view-model.test.ts`
- Create: `apps/web/src/features/conversation/conversation-panel.tsx`
- Create: `apps/web/src/features/conversation/conversation-panel.test.tsx`

- [ ] **Step 1: Write failing reducer tests**

Feed AG-UI Message, Tool, Step, Activity, Evidence, and Artifact events. Assert one Assistant Message per stable ID, streaming content updates in place, replayed events are ignored by `(threadId, sequence)`, consecutive progress folds into one ActivityGroup, and raw reasoning is never exposed.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @ira/web test -- agent-view-model.test.ts conversation-panel.test.tsx`

Expected: FAIL because the adapter is missing.

- [ ] **Step 3: Implement the pure adapter boundary**

```ts
export type ConversationViewModel = {
  messages: Array<{ id: string; role: "user" | "assistant"; content: string; streaming: boolean }>;
  activities: ActivityItem[];
  tools: ToolCallView[];
  citations: CitationView[];
  artifacts: ArtifactView[];
  runState: RunVisualState;
};
```

The panel uses `useAgent({ agentId: "research-agent" })` and subscriptions, but passes only view models to `@ira/ui`.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @ira/web test -- agent-view-model.test.ts conversation-panel.test.tsx && pnpm --filter @ira/web typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/conversation
git commit -m "feat: render persisted AG-UI conversation state"
```

### Task 4: Implement Composer send, Stop, reconnect, and snapshot hydration

**Files:**
- Create: `apps/web/src/features/conversation/use-research-run.ts`
- Create: `apps/web/src/features/conversation/use-research-run.test.tsx`
- Modify: `apps/web/src/features/conversation/conversation-panel.tsx`

- [ ] **Step 1: Write failing interaction tests**

Assert send adds one user message with stable UUID and invokes `copilotkit.runAgent`; running disables send and enables Stop; Stop calls Agent cancellation; reconnect hydrates `MESSAGES_SNAPSHOT` then replays after `last_event_seq`; duplicate sequence does not duplicate a reply.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @ira/web test -- use-research-run.test.tsx`

Expected: FAIL because the hook is missing.

- [ ] **Step 3: Implement the hook**

Maintain only `draft`, `connectionState`, and one in-flight client idempotency key locally. On successful submission rotate the key; on retry reuse it. Map `run_cancelled` to cancelled visual state and suppress the generic error banner.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @ira/web test -- use-research-run.test.tsx conversation-panel.test.tsx && pnpm --filter @ira/web typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/conversation
git commit -m "feat: add reliable research run controls"
```

### Task 5: Implement native Interrupt approval UI

**Files:**
- Create: `apps/web/src/features/interrupts/approval-interrupt.tsx`
- Create: `apps/web/src/features/interrupts/approval-interrupt.test.tsx`
- Modify: `apps/web/src/features/conversation/conversation-panel.tsx`

- [ ] **Step 1: Write failing approval tests**

Cover standard `RUN_FINISHED.outcome.interrupts`, schema-driven Approve/Reject, Cancel, multiple open Interrupt accumulation, busy state, invalid payload prevention, conflicting `409` refresh, and no ordinary send while Interrupts are open.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @ira/web test -- approval-interrupt.test.tsx`

Expected: FAIL because the component is missing.

- [ ] **Step 3: Implement with `useInterrupt`**

Use `renderInChat: false`; render the returned element in the timeline/Inspector location chosen by the view model. Call `resolve({ approved: true })`, `resolve({ approved: false, reason })`, or `cancel()`. Do not call a separate browser approval endpoint.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @ira/web test -- approval-interrupt.test.tsx && pnpm --filter @ira/web typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/interrupts apps/web/src/features/conversation/conversation-panel.tsx
git commit -m "feat: resume research approvals through AG-UI interrupts"
```

### Task 6: Build Inspector adapters and the workbench shell

**Files:**
- Create: `apps/web/src/features/inspector/inspector-state.ts`
- Create: `apps/web/src/features/inspector/inspector-state.test.ts`
- Create: `apps/web/src/features/inspector/research-inspector.tsx`
- Create: `apps/web/src/features/inspector/research-inspector.test.tsx`
- Create: `apps/web/src/app/research-workbench.tsx`
- Create: `apps/web/src/app/research-workbench.test.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Write failing shell/Inspector tests**

Assert citation opens Evidence details, Artifact opens preview/version/save state, Tool opens parameters/result/duration/error, Approval opens impact/decision, close returns focus, and full Artifact bodies never appear in the conversation.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @ira/web test -- inspector-state.test.ts research-inspector.test.tsx research-workbench.test.tsx`

Expected: FAIL because workbench modules are missing.

- [ ] **Step 3: Implement discriminated Inspector state**

```ts
export type InspectorTarget =
  | { kind: "evidence"; id: string }
  | { kind: "artifact"; id: string }
  | { kind: "tool"; id: string }
  | { kind: "approval"; id: string }
  | null;
```

Compose `ResearchShell`, `ThreadList`, `Conversation`, `Composer`, and `Inspector`; keep fetching in feature adapters, not `@ira/ui`.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @ira/web test && pnpm --filter @ira/web typecheck && pnpm --filter @ira/web build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/inspector apps/web/src/app apps/web/src/App.tsx
git commit -m "feat: compose Codex-style research workbench"
```

### Task 7: Remove prototype UI and complete browser E2E

**Files:**
- Create: `tests/e2e/research-workbench.spec.ts`
- Delete: `apps/web/src/lib/chat-api.ts`
- Delete: `apps/web/src/components/Composer.tsx`
- Delete: `apps/web/src/components/MessageList.tsx`
- Delete: `apps/web/src/components/ResearchTrace.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `package.json`

- [ ] **Step 1: Write failing browser E2E**

Cover new/switch/rename task, one streamed response, ActivityGroup, Tool state, citation-to-Inspector, Artifact card without body, Stop, refresh replay, approval approve/reject/cancel, Runtime restart recovery, narrow viewport, and exactly one Assistant Message after reconnect.

- [ ] **Step 2: Run E2E and verify failure**

Run: `pnpm playwright test tests/e2e/research-workbench.spec.ts`

Expected: FAIL until the complete workbench is wired.

- [ ] **Step 3: Complete wiring and delete the prototype**

Remove all custom EventSource event-name lists and `stream-*` reconciliation. `styles.css` may contain only app-level reset/layout imports; component colors stay in `@ira/ui` tokens.

- [ ] **Step 4: Run full verification**

Run: `services/research/.venv/bin/pytest services/research/tests -q && pnpm test && pnpm typecheck && pnpm --filter @ira/web build && pnpm vitest run tests/e2e/ag-ui-runtime.test.ts && pnpm playwright test tests/e2e/research-workbench.spec.ts tests/visual/research-ui.spec.ts`

Expected: all commands exit 0 with no failed tests and the build contains no old custom chat event strings.

- [ ] **Step 5: Commit**

```bash
git add -A apps/web tests/e2e package.json
git commit -m "refactor: replace prototype chat with research workbench"
```
