import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../../apps/chat-backend/src/app.js";
import { FakeAgentSession } from "./fake-agent-session.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";

function fakeClient() {
  const events = new Map<string, any[]>();
  const runs = new Map<string, any>();
  let seq = 0;
  return {
    async createAguiRun(thread_id: string, input: unknown, key: string) {
      const old = [...runs.values()].find((r) => r.thread_id === thread_id && r.idempotency_key === key);
      if (old) return { run: { ...old, replayed: true }, replayed: true, last_event_seq: seq };
      const run = { id: `run-${++seq}`, thread_id, idempotency_key: key, status: "running", model: null };
      runs.set(run.id, run);
      events.set(thread_id, []);
      return { run, replayed: false, last_event_seq: 0 };
    },
    async appendAguiEvents(thread_id: string, run_id: string, values: any[]) {
      const list = events.get(thread_id) ?? [];
      const created = values.map((v) => ({ thread_id, run_id, sequence: ++seq, type: v.type, data: v.data }));
      list.push(...created); events.set(thread_id, list); return { events: created };
    },
    async listAguiEvents(thread_id: string, after = 0) { return (events.get(thread_id) ?? []).filter((e) => e.sequence > after); },
    async transitionAguiRun(run_id: string, status: string) { const run = runs.get(run_id); run.status = status; return run; },
    async getAguiState(thread_id: string) { return { thread: { id: thread_id, title: "", title_source: "", title_locked: false, created_at: "" }, last_event_seq: (events.get(thread_id) ?? []).at(-1)?.sequence ?? 0, runs: [...runs.values()].filter((r) => r.thread_id === thread_id) }; },
  } as any;
}

describe("AG-UI runtime process contract", () => {
  it("discovers capabilities through a real Python research-service process", async () => {
    const researchPort = await freePort();
    const runtimePort = await freePort();
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ira-task9-"));
    const pythonExecutable = process.env.IRA_E2E_PYTHON ?? path.resolve("services/research/.venv/bin/python");
    const python = spawn(pythonExecutable, [path.join(path.dirname(fileURLToPath(import.meta.url)), "python_server.py"), path.join(tempDir, "research.duckdb"), String(researchPort)], {
      cwd: path.resolve("services/research"),
      env: { ...process.env, PYTHONPATH: path.resolve("services/research") },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const tsx = path.resolve("node_modules/.bin/tsx");
    const runtime = spawn(tsx, [path.resolve("apps/copilot-runtime/src/server.ts")], {
      env: { ...process.env, PORT: String(runtimePort), IRA_RESEARCH_SERVICE_URL: `http://127.0.0.1:${researchPort}` },
      stdio: ["ignore", "pipe", "inherit"],
    });
    try {
      await waitFor(`http://127.0.0.1:${researchPort}/v1/threads`);
      await waitFor(`http://127.0.0.1:${runtimePort}/health`);
      const created = await fetch(`http://127.0.0.1:${researchPort}/v1/threads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
      expect(created.status).toBe(201);
      const info = await fetch(`http://127.0.0.1:${runtimePort}/info`);
      expect(info.status).toBe(200);
      const payload = await info.json() as { agents: Array<{ name: string; capabilities: unknown }> };
      expect(payload.agents.map((agent) => agent.name)).toContain("research-agent");
      expect(payload.agents[0]?.capabilities).toBeDefined();
    } finally {
      await stopProcess(runtime);
      await stopProcess(python);
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("persists cancellation and interrupt decisions across the Python process boundary", async () => {
    const researchPort = await freePort();
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ira-task9-state-"));
    const python = spawn(process.env.IRA_E2E_PYTHON ?? path.resolve("services/research/.venv/bin/python"), [path.join(path.dirname(fileURLToPath(import.meta.url)), "python_server.py"), path.join(tempDir, "research.duckdb"), String(researchPort)], {
      cwd: path.resolve("services/research"), env: { ...process.env, PYTHONPATH: path.resolve("services/research") }, stdio: ["ignore", "pipe", "inherit"],
    });
    const base = `http://127.0.0.1:${researchPort}`;
    try {
      await waitFor(`${base}/v1/threads`);
      const thread = "task9-state";
      await fetch(`${base}/v1/threads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: thread }) });
      const runResponse = await fetch(`${base}/v1/threads/${thread}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: thread, pi_session_id: "pi-task9", model: "fixture", idempotency_key: "cancel-once" }) });
      expect(runResponse.status).toBe(201);
      const run = await runResponse.json() as { run_id?: string; id?: string; run?: { run_id?: string; id?: string } };
      const runId = run.run_id ?? run.id ?? run.run?.run_id ?? run.run?.id;
      expect(runId).toBeTruthy();
      const cancelled = await fetch(`${base}/v1/runs/${runId}/transition`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "cancelled", error: { code: "run_cancelled" } }) });
      expect(cancelled.status).toBe(200);
      expect((await cancelled.json()).status).toBe("cancelled");
      const eventBatch = await fetch(`${base}/v1/threads/${thread}/events:batch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ run_id: runId, events: [{ type: "TOOL_CALL_START", data: { toolCallId: "call-1" } }] }) });
      expect(eventBatch.status).toBe(200);
      const interrupt = await fetch(`${base}/v1/internal/interrupts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ thread_id: thread, interrupt_id: "approval-1", run_id: runId, nonce: "nonce-1", tool_name: "query_company_snapshot", input: { ticker: "300476.SZ" }, last_event_seq: 1 }) });
      expect([200, 201]).toContain(interrupt.status);
      const resolution = await fetch(`${base}/v1/internal/interrupts/${thread}/resolve-set`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions: [{ interrupt_id: "approval-1", nonce: "nonce-1", status: "resolved", payload: { approved: false } }] }) });
      expect(resolution.status).toBe(200);
      const decision = await fetch(`${base}/v1/internal/interrupts/${thread}/resolve-set`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions: [{ interrupt_id: "approval-1", nonce: "nonce-1", status: "resolved", payload: { approved: false } }] }) });
      expect(decision.status).toBe(200);
      expect((await decision.json()).receipts[0].payload.approved).toBe(false);
      const replay = await fetch(`${base}/v1/internal/interrupts/${thread}`);
      expect((await replay.json()).length).toBe(0);
    } finally { await stopProcess(python); await rm(tempDir, { recursive: true, force: true }); }
  }, 30_000);

  it("resolves an approve/reject/cancel decision set through child Fastify and Python processes", async () => {
    const stack = await startDurableStack("decision-set");
    const thread = "task9-decision-set";
    try {
      const prepared = await createInterruptedRun(stack.researchBase, thread, [
        { id: "approve", nonce: "approve-nonce", toolCallId: "tool-approve", status: "resolved", approved: true },
        { id: "reject", nonce: "reject-nonce", toolCallId: "tool-reject", status: "resolved", approved: false },
        { id: "cancel", nonce: "cancel-nonce", toolCallId: "tool-cancel", status: "cancelled", approved: false },
      ]);
      const response = await fetch(`${stack.chatBase}/v1/threads/${thread}/interrupts/resume`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ decisions: prepared.decisions }),
      });
      expect(response.status).toBe(200);
      const recovered = await response.json() as { recovery_run_id: string; results: Array<{ operation_id: string; result: unknown }> };
      expect(recovered.results).toHaveLength(3);
      expect((recovered.results[0]?.result as { ticker?: string }).ticker).toBe("300476.SZ");
      expect(recovered.results.slice(1).map((item) => item.result)).toEqual([
        { status: "rejected", approved: false },
        { status: "cancelled", approved: false },
      ]);
      const events = await json(`${stack.researchBase}/v1/threads/${thread}/events`) as Array<{ run_id: string; type: string; data: { toolCallId?: string } }>;
      const results = events.filter((event) => event.run_id === recovered.recovery_run_id && event.type === "TOOL_CALL_RESULT");
      expect(results.map((event) => event.data.toolCallId)).toEqual(["tool-approve", "tool-reject", "tool-cancel"]);
    } finally { await stack.stop(); }
  }, 45_000);

  it("recovers after Python, Fastify, and Runtime restart using the same durable state", async () => {
    const stack = await startDurableStack("restart");
    const thread = "task9-restart";
    try {
      const prepared = await createInterruptedRun(stack.researchBase, thread, [
        { id: "restart", nonce: "restart-nonce", toolCallId: "old-tool-call", status: "resolved", approved: true },
      ]);
      await stack.restart();
      expect((await fetch(`${stack.runtimeBase}/info`)).status).toBe(200);
      const response = await fetch(`${stack.chatBase}/v1/threads/${thread}/interrupts/resume`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions: prepared.decisions }),
      });
      expect(response.status).toBe(200);
      const recovered = await response.json() as { recovery_run_id: string };
      const events = await json(`${stack.researchBase}/v1/threads/${thread}/events`) as Array<{ run_id: string; type: string; data: { toolCallId?: string } }>;
      expect(events.some((event) => event.run_id === recovered.recovery_run_id && event.type === "TOOL_CALL_RESULT" && event.data.toolCallId === "old-tool-call")).toBe(true);
      const operation = await json(`${stack.researchBase}/v1/internal/operations/status`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ thread_id: thread, operation_id: prepared.operationIds[0] }),
      }) as { status: string };
      expect(operation.status).toBe("succeeded");
    } finally { await stack.stop(); }
  }, 60_000);

  it("uses durable recovery_fallback when the recorded Pi session storage is missing", async () => {
    const stack = await startDurableStack("missing-session");
    const thread = "task9-missing-session";
    try {
      const storage = path.join(stack.runtimeDir, "sessions", "lost", "session");
      await mkdir(storage, { recursive: true });
      await writeFile(path.join(storage, "state.json"), "broken before resume");
      const prepared = await createInterruptedRun(stack.researchBase, thread, [
        { id: "lost", nonce: "lost-nonce", toolCallId: "historic-tool", status: "resolved", approved: true, storageRef: "sessions/lost/session" },
      ]);
      await rm(storage, { recursive: true, force: true });
      const response = await fetch(`${stack.chatBase}/v1/threads/${thread}/interrupts/resume`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions: prepared.decisions }),
      });
      expect(response.status).toBe(200);
      const recovered = await response.json() as { recovery_run_id: string };
      const state = await json(`${stack.researchBase}/v1/threads/${thread}/state`) as { runs: Array<{ id: string; status: string }> };
      expect(state.runs).toContainEqual(expect.objectContaining({ id: recovered.recovery_run_id, status: "completed" }));
      const events = await json(`${stack.researchBase}/v1/threads/${thread}/events`) as Array<{ run_id: string; type: string; data: { toolCallId?: string } }>;
      expect(events.some((event) => event.run_id === recovered.recovery_run_id && event.type === "TOOL_CALL_RESULT" && event.data.toolCallId === "historic-tool")).toBe(true);
    } finally { await stack.stop(); }
  }, 45_000);

  it("crosses a child-process runtime boundary and preserves persisted SSE ids", async () => {
    const port = await freePort();
    const tsx = path.resolve("node_modules/.bin/tsx");
    const fixture = spawn(tsx, [path.join(path.dirname(fileURLToPath(import.meta.url)), "runtime-upstream-fixture.ts"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
    const [line] = await once(fixture.stdout!, "data") as [Buffer];
    const upstreamPort = Number(line.toString().trim().split(":")[1]);
    const runtime = spawn(tsx, [path.resolve("apps/copilot-runtime/src/server.ts")], { env: { ...process.env, PORT: String(port), IRA_RESEARCH_SERVICE_URL: `http://127.0.0.1:${upstreamPort}`, IRA_RUNTIME_MAX_POLLS: "10" }, stdio: ["ignore", "pipe", "inherit"] });
    try {
      await waitFor(`http://127.0.0.1:${port}/health`);
      const response = await fetch(`http://127.0.0.1:${port}/agent/research-agent/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: "child-thread", input: "research" }) });
      const text = await response.text();
      const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
      expect(response.status).toBe(200);
      expect(ids.length).toBe(3);
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
      expect((text.match(/messageId/g) ?? []).length).toBe(1);
    } finally {
      runtime.kill("SIGTERM"); fixture.kill("SIGTERM");
      await Promise.allSettled([once(runtime, "exit"), once(fixture, "exit")]);
    }
  }, 20_000);

  it("streams persisted events, supports reconnect cursor and idempotent duplicate", async () => {
    const client = fakeClient();
    const app = await createApp({ researchClient: client, sessionFactory: async (id) => new FakeAgentSession(id) as any });
    await app.ready();
    const first = await app.inject({ method: "POST", url: "/v1/threads/thread-1/runs", payload: { input: "research", idempotency_key: "same" } });
    expect(first.statusCode).toBe(200);
    const duplicate = await app.inject({ method: "POST", url: "/v1/threads/thread-1/runs", payload: { input: "research", idempotency_key: "same" } });
    expect(duplicate.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const replay = await app.inject({ method: "GET", url: "/v1/threads/thread-1/events?after=0" });
    const body = replay.json() as Array<{ sequence: number; type: string }>;
    expect(body.length).toBeGreaterThan(0);
    expect(body.map((e) => e.sequence)).toEqual([...body].sort((a, b) => a - b).map((e) => e.sequence));
    await app.close();
  });

  it("replays only events after Last-Event-ID with monotonic ids", async () => {
    const client = fakeClient();
    const app = await createApp({ researchClient: client, sessionFactory: async (id) => new FakeAgentSession(id) as any });
    await app.ready();
    await app.inject({ method: "POST", url: "/v1/threads/thread-2/runs", payload: { input: "research", idempotency_key: "cursor" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const all = await app.inject({ method: "GET", url: "/v1/threads/thread-2/events?after=0" });
    const events = all.json() as Array<{ sequence: number }>;
    expect(events.length).toBeGreaterThan(0);
    const cursor = events[0]!.sequence;
    const resumed = await app.inject({ method: "GET", url: "/v1/threads/thread-2/events", headers: { "last-event-id": String(cursor) } });
    expect((resumed.json() as Array<{ sequence: number }>).every((event) => event.sequence > cursor)).toBe(true);
    await app.close();
  });
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitFor(url: string): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    try { if ((await fetch(url)).ok) return; } catch { /* process is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function waitForResponse(url: string): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    try {
      await fetch(url);
      return;
    } catch { /* process is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function stopProcess(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(() => { child.kill("SIGKILL"); resolve(undefined); }, 2_000)),
  ]);
}

type DecisionFixture = {
  id: string;
  nonce: string;
  toolCallId: string;
  status: "resolved" | "cancelled";
  approved: boolean;
  storageRef?: string;
};

async function json(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${url} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function createInterruptedRun(base: string, thread: string, fixtures: DecisionFixture[]) {
  await json(`${base}/v1/threads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: thread }) });
  const created = await json(`${base}/v1/threads/${thread}/runs`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: { messages: [{ role: "user", content: "recover this research" }] }, idempotency_key: `initial-${thread}`, model: "fixture" }),
  }) as { run: { id: string } };
  const runId = created.run.id;
  const event = await json(`${base}/v1/threads/${thread}/events:batch`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ run_id: runId, events: fixtures.map((fixture) => ({ type: "TOOL_CALL_START", data: { toolCallId: fixture.toolCallId } })) }),
  }) as { events: Array<{ sequence: number }> };
  const lastEventSeq = event.events.at(-1)!.sequence;
  const decisions = [] as Array<{ interrupt_id: string; nonce: string; status: "resolved" | "cancelled"; payload: { approved: boolean } }>;
  const operationIds: string[] = [];
  for (const fixture of fixtures) {
    const interrupt = await json(`${base}/v1/internal/interrupts`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        thread_id: thread, interrupt_id: fixture.id, run_id: runId, nonce: fixture.nonce,
        tool_name: "query_company_snapshot", input: { ticker: "300476.SZ" }, tool_call_id: fixture.toolCallId,
        last_event_seq: lastEventSeq, pi_session_id: "expired-pi-session", pi_session_revision: 7,
        pi_session_storage_ref: fixture.storageRef ?? "sessions/expired/session",
      }),
    }) as { operation_id: string };
    operationIds.push(interrupt.operation_id);
    decisions.push({ interrupt_id: fixture.id, nonce: fixture.nonce, status: fixture.status, payload: { approved: fixture.approved } });
  }
  return { decisions, operationIds };
}

async function startDurableStack(label: string) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), `ira-task9-${label}-`));
  const database = path.join(tempDir, "research.duckdb");
  const runtimeDir = path.join(tempDir, ".ira-runtime");
  const researchPort = await freePort();
  const chatPort = await freePort();
  const runtimePort = await freePort();
  const pythonExecutable = process.env.IRA_E2E_PYTHON ?? path.resolve("services/research/.venv/bin/python");
  const tsx = path.resolve("node_modules/.bin/tsx");
  let children: Array<ReturnType<typeof spawn>> = [];
  const researchBase = `http://127.0.0.1:${researchPort}`;
  const chatBase = `http://127.0.0.1:${chatPort}`;
  const runtimeBase = `http://127.0.0.1:${runtimePort}`;
  const launch = async () => {
    const python = spawn(pythonExecutable, [path.join(path.dirname(fileURLToPath(import.meta.url)), "python_server.py"), database, String(researchPort)], {
      cwd: path.resolve("services/research"), env: { ...process.env, PYTHONPATH: path.resolve("services/research") }, stdio: ["ignore", "pipe", "inherit"],
    });
    const chat = spawn(tsx, [path.resolve("apps/chat-backend/src/server.ts")], {
      env: { ...process.env, PORT: String(chatPort), IRA_RESEARCH_SERVICE_URL: researchBase, IRA_RUNTIME_DIR: runtimeDir }, stdio: ["ignore", "pipe", "inherit"],
    });
    const runtime = spawn(tsx, [path.resolve("apps/copilot-runtime/src/server.ts")], {
      env: { ...process.env, PORT: String(runtimePort), IRA_RESEARCH_SERVICE_URL: researchBase }, stdio: ["ignore", "pipe", "inherit"],
    });
    children = [python, chat, runtime];
    await Promise.all([waitFor(`${researchBase}/v1/threads`), waitForResponse(`${chatBase}/v1/threads/no-such/state`), waitFor(`${runtimeBase}/health`)]);
  };
  const stopChildren = async () => { await Promise.all(children.map(stopProcess)); children = []; };
  await launch();
  return {
    researchBase, chatBase, runtimeBase, runtimeDir,
    restart: async () => { await stopChildren(); await launch(); },
    stop: async () => { await stopChildren(); await rm(tempDir, { recursive: true, force: true }); },
  };
}
