# Research UI Design System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an internal dark research design system with accessible chat, activity, evidence, artifact, approval, and inspector primitives that can be consumed by the AG-UI application.

**Architecture:** `packages/ui` owns tokens, shadcn-derived primitives, and domain-neutral presentation components. Storybook is the executable component contract; components accept typed view models and callbacks but do not import CopilotKit, Fastify clients, PCB logic, or application stores.

**Tech Stack:** React 19, TypeScript 5.9, Tailwind CSS 4, shadcn/ui source components, Radix UI, Lucide, Storybook, Vitest, Testing Library, axe.

---

## File map

- `packages/ui/src/styles/theme.css`: semantic OKLCH tokens and typography.
- `packages/ui/src/primitives/*`: repository-owned shadcn primitives.
- `packages/ui/src/chat/*`: messages, composer, activities, tools, citations.
- `packages/ui/src/research/*`: evidence, artifacts, approvals, metrics.
- `packages/ui/src/layout/*`: shell, task sidebar, inspector.
- `packages/ui/stories/*`: visual and interaction contracts.
- `.storybook/*`: Storybook configuration shared by the package.

### Task 1: Scaffold `packages/ui`, Tailwind, and Storybook

**Files:**
- Create: `packages/ui/package.json`
- Create: `packages/ui/tsconfig.json`
- Create: `packages/ui/components.json`
- Create: `packages/ui/src/index.ts`
- Create: `packages/ui/src/styles/theme.css`
- Create: `.storybook/main.ts`
- Create: `.storybook/preview.tsx`
- Modify: `pnpm-workspace.yaml`
- Modify: `package.json`

- [ ] **Step 1: Write the failing package smoke test**

Create `packages/ui/src/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { researchThemeClass } from "./index.js";

describe("ui package", () => {
  it("exports the dark research theme", () => expect(researchThemeClass).toBe("ira-theme-dark"));
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `pnpm --filter @ira/ui test`

Expected: FAIL because the package does not exist.

- [ ] **Step 3: Create the package and token foundation**

Use exact scripts `test`, `typecheck`, and `storybook`; export `researchThemeClass = "ira-theme-dark"`. Define semantic variables for background, three surfaces, text, muted text, border, focus, success, running, warning, destructive, evidence, and approval. Components may use only semantic tokens.

- [ ] **Step 4: Configure Storybook**

Load `theme.css` once in preview, set dark background, enable controls/actions, and add viewport presets for 1440px, 1024px, and 768px.

- [ ] **Step 5: Run package checks**

Run: `pnpm --filter @ira/ui test && pnpm --filter @ira/ui typecheck && pnpm storybook --smoke-test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ui .storybook package.json pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat: scaffold research UI design system"
```

### Task 2: Add the minimal shadcn primitive layer

**Files:**
- Create: `packages/ui/src/lib/cn.ts`
- Create: `packages/ui/src/primitives/button.tsx`
- Create: `packages/ui/src/primitives/textarea.tsx`
- Create: `packages/ui/src/primitives/tooltip.tsx`
- Create: `packages/ui/src/primitives/badge.tsx`
- Create: `packages/ui/src/primitives/scroll-area.tsx`
- Create: `packages/ui/src/primitives/collapsible.tsx`
- Create: `packages/ui/src/primitives/sheet.tsx`
- Create: `packages/ui/src/primitives/resizable.tsx`
- Create: `packages/ui/src/primitives/primitives.test.tsx`
- Modify: `packages/ui/src/index.ts`

- [ ] **Step 1: Write failing accessibility tests**

Render Button, Tooltip, Collapsible, Sheet, and Textarea. Assert keyboard activation, accessible names, Escape closing behavior, visible focus, and disabled semantics.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @ira/ui test -- primitives.test.tsx`

Expected: FAIL because primitives are missing.

- [ ] **Step 3: Add shadcn source components**

Use the monorepo aliases from `components.json`; keep Radix behavior intact; replace shadcn color literals with the package semantic tokens; export public props without research-specific fields.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @ira/ui test && pnpm --filter @ira/ui typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui
git commit -m "feat: add accessible UI primitives"
```

### Task 3: Build message, activity, tool, citation, and composer components

**Files:**
- Create: `packages/ui/src/chat/types.ts`
- Create: `packages/ui/src/chat/conversation.tsx`
- Create: `packages/ui/src/chat/message.tsx`
- Create: `packages/ui/src/chat/activity-group.tsx`
- Create: `packages/ui/src/chat/tool-call.tsx`
- Create: `packages/ui/src/chat/source-citation.tsx`
- Create: `packages/ui/src/chat/composer.tsx`
- Create: `packages/ui/src/chat/chat.test.tsx`
- Create: `packages/ui/stories/chat.stories.tsx`
- Modify: `packages/ui/src/index.ts`

- [ ] **Step 1: Define typed view models and failing tests**

Use this public boundary:

```ts
export type RunVisualState = "idle" | "running" | "interrupted" | "completed" | "failed" | "cancelled";
export type ActivityItem = { id: string; label: string; status: "running" | "completed" | "failed"; durationMs?: number; error?: string };
export type ToolCallView = { id: string; name: string; status: ActivityItem["status"]; durationMs?: number; summary?: string };
export type CitationView = { id: string; title: string; source?: string; publishedAt?: string };
```

Test stable message IDs, collapsed completed activities, expanded failures, citation callbacks, Enter-to-send, Shift+Enter newline, running-state send disabled, and Stop enabled.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @ira/ui test -- chat.test.tsx`

Expected: FAIL because components are missing.

- [ ] **Step 3: Implement minimal components**

Assistant text uses document flow rather than a large card; user text uses a restrained bubble; activities expose only action/status summaries and never raw chain-of-thought. Composer callbacks are `onSend(value: string)` and `onStop()`.

- [ ] **Step 4: Add Storybook states**

Provide Default, Streaming, LongContent, ToolFailure, Empty, RunningComposer, and NarrowViewport stories with fixed deterministic data.

- [ ] **Step 5: Verify**

Run: `pnpm --filter @ira/ui test && pnpm --filter @ira/ui typecheck && pnpm storybook --smoke-test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/chat packages/ui/stories/chat.stories.tsx packages/ui/src/index.ts
git commit -m "feat: add agent conversation components"
```

### Task 4: Build evidence, artifact, approval, and metric components

**Files:**
- Create: `packages/ui/src/research/types.ts`
- Create: `packages/ui/src/research/evidence-card.tsx`
- Create: `packages/ui/src/research/artifact-card.tsx`
- Create: `packages/ui/src/research/approval-card.tsx`
- Create: `packages/ui/src/research/metric-value.tsx`
- Create: `packages/ui/src/research/research.test.tsx`
- Create: `packages/ui/stories/research.stories.tsx`
- Modify: `packages/ui/src/index.ts`

- [ ] **Step 1: Define public types and failing tests**

```ts
export type EvidenceView = { id: string; title: string; locator: string; publishedAt?: string; applicableAt?: string; confidence: "high" | "medium" | "low"; direction: "supports" | "contradicts" | "neutral" };
export type ArtifactView = { id: string; title: string; summary: string; kind: string; version: number; saved: boolean };
export type ApprovalView = { id: string; message: string; status: "pending" | "approved" | "rejected" | "cancelled"; impact: string; busy?: boolean };
```

Test that long Artifact bodies are never rendered, pending approval exposes Approve/Reject/Cancel callbacks, decided approvals disable actions, and missing Evidence dates are labeled unavailable rather than invented.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @ira/ui test -- research.test.tsx`

Expected: FAIL because components are missing.

- [ ] **Step 3: Implement components and stories**

Approval actions require explicit labels; destructive styling is reserved for rejection/cancellation, not ordinary warnings. Metric values use tabular numerals and always display unit and as-of date when supplied.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @ira/ui test && pnpm --filter @ira/ui typecheck && pnpm storybook --smoke-test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/research packages/ui/stories/research.stories.tsx packages/ui/src/index.ts
git commit -m "feat: add research evidence and approval components"
```

### Task 5: Build shell, task sidebar, and Inspector layout

**Files:**
- Create: `packages/ui/src/layout/types.ts`
- Create: `packages/ui/src/layout/research-shell.tsx`
- Create: `packages/ui/src/layout/thread-list.tsx`
- Create: `packages/ui/src/layout/inspector.tsx`
- Create: `packages/ui/src/layout/layout.test.tsx`
- Create: `packages/ui/stories/layout.stories.tsx`
- Modify: `packages/ui/src/index.ts`

- [ ] **Step 1: Write failing responsive and keyboard tests**

Test sidebar selection, manual collapse, Inspector close/focus return, resizable wide layout, Sheet behavior on narrow viewport, and Escape handling.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @ira/ui test -- layout.test.tsx`

Expected: FAIL because layout components are missing.

- [ ] **Step 3: Implement controlled layout components**

`ResearchShell` receives `sidebar`, `conversation`, and optional `inspector` slots. `Inspector` receives `open`, `title`, `onOpenChange`, and content; it contains no fetching logic. `ThreadList` receives stable IDs, title, updated time, securities, and visual Run state.

- [ ] **Step 4: Add wide, medium, and narrow stories**

Inspector is closed by default. Wide stories show inline resizing; medium/narrow stories show overlay/Sheet behavior.

- [ ] **Step 5: Run Phase 2 verification**

Run: `pnpm --filter @ira/ui test && pnpm --filter @ira/ui typecheck && pnpm storybook --smoke-test`

Expected: all commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/layout packages/ui/stories/layout.stories.tsx packages/ui/src/index.ts
git commit -m "feat: add Codex-style research workspace layout"
```

### Task 6: Add accessibility and visual regression gates

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/visual/research-ui.spec.ts`
- Create: `tests/visual/research-ui.spec.ts-snapshots/.gitkeep`
- Modify: `package.json`
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the visual/accessibility test**

Start Storybook through Playwright `webServer`; visit stable story URLs for chat default/streaming/error, research approval/evidence/artifact, and layout wide/narrow. Run axe with no serious/critical violations and capture fixed-viewport screenshots with animations disabled.

- [ ] **Step 2: Run the test and verify failure**

Run: `pnpm playwright test tests/visual/research-ui.spec.ts`

Expected: FAIL because Playwright configuration, baselines, and CI browser installation are missing.

- [ ] **Step 3: Configure deterministic visual testing**

Pin `@playwright/test`; add `test:visual`; use Chromium, locale `zh-CN`, timezone `Asia/Shanghai`, reduced motion, fixed fonts, and a 1440×1000 desktop plus 768×900 narrow project. CI installs Chromium with dependencies before testing.

- [ ] **Step 4: Generate and review baselines**

Run: `pnpm playwright test tests/visual/research-ui.spec.ts --update-snapshots`

Expected: baseline PNGs are created only for the enumerated stable stories; inspect each image before staging.

- [ ] **Step 5: Run Phase 2 verification**

Run: `pnpm --filter @ira/ui test && pnpm --filter @ira/ui typecheck && pnpm storybook --smoke-test && pnpm playwright test tests/visual/research-ui.spec.ts`

Expected: all commands exit 0 with no serious/critical accessibility violations or screenshot differences.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml playwright.config.ts tests/visual .github/workflows/ci.yml
git commit -m "test: add research UI visual regression"
```
