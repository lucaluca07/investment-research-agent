import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";

// Every case starts three child servers.  Keep them serial: reserving an
// ephemeral port and spawning a server are not atomic across concurrent cases.
describe.sequential("AG-UI runtime process contract", () => {
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

  it("streams, reconnects, and deduplicates through Python, Fastify, and Runtime child processes", async () => {
    const stack = await startDurableStack("streaming-boundary");
    const thread = "task9-streaming-boundary";
    try {
      await json(`${stack.researchBase}/v1/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: thread }),
      });
      const request = {
        threadId: thread,
        input: "research Victory Giant",
        idempotency_key: "stream-once",
      };
      const first = await fetch(`${stack.runtimeBase}/agent/research-agent/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      const firstText = await first.text();
      const firstEvents = sseEvents(firstText);
      const firstIds = firstEvents.map((event) => event.sequence);
      expect(first.status).toBe(200);
      expect(firstIds.length).toBeGreaterThanOrEqual(3);
      expect(firstIds).toEqual([...firstIds].sort((left, right) => left - right));

      const reconnect = await fetch(`${stack.runtimeBase}/agent/research-agent/run`, {
        method: "POST",
        headers: { "content-type": "application/json", "last-event-id": String(firstIds[0]) },
        body: JSON.stringify(request),
      });
      const reconnectText = await reconnect.text();
      const reconnectIds = sseEvents(reconnectText).map((event) => event.sequence);
      expect(reconnect.status).toBe(200);
      expect(reconnectIds.length).toBeGreaterThan(0);
      expect(reconnectIds.every((id) => id > firstIds[0]!)).toBe(true);

      const duplicate = await fetch(`${stack.runtimeBase}/agent/research-agent/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      const duplicateText = await duplicate.text();
      const duplicateIds = sseEvents(duplicateText).map((event) => event.sequence);
      expect(duplicate.status).toBe(200);
      expect(duplicateIds).toEqual(firstIds);
      const rendered = applySseReplay(firstText, reconnectText, duplicateText);
      const assistantMessageIds = rendered
        .filter((event) => event.type === "TEXT_MESSAGE_START")
        .map((event) => event.data.messageId);
      expect(assistantMessageIds).toEqual([expect.any(String)]);
      expect(new Set(assistantMessageIds).size).toBe(assistantMessageIds.length);
      expect(rendered.filter((event) => event.type === "TEXT_MESSAGE_CONTENT").map((event) => event.data.messageId))
        .toEqual(assistantMessageIds);
      const state = await json(`${stack.researchBase}/v1/threads/${thread}/state`) as { runs: unknown[] };
      expect(state.runs).toHaveLength(1);
    } finally {
      await stack.stop();
    }
  }, 45_000);

  it("forwards standard RunAgentInput messages through all three processes to Pi", async () => {
    const stack = await startDurableStack("standard-run-agent-input");
    const thread = "task9-standard-run-agent-input";
    try {
      await json(`${stack.researchBase}/v1/threads`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: thread }),
      });
      const response = await fetch(`${stack.runtimeBase}/agent/research-agent/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: thread,
          runId: "standard-agui-run",
          messages: [
            { id: "old", role: "user", content: "old prompt" },
            { id: "new", role: "user", content: [{ type: "text", text: "research standard AG-UI PCB" }] },
          ],
        }),
      });
      const events = sseEvents(await response.text());
      expect(response.status).toBe(200);
      expect(events.filter((event) => event.type === "TEXT_MESSAGE_CONTENT").map((event) => (event.data as any).delta))
        .toContain("research standard AG-UI PCB");
    } finally {
      await stack.stop();
    }
  }, 45_000);
});

type SseEvent = { sequence: number; type: string; data: { messageId?: string } };

function sseEvents(text: string): SseEvent[] {
  return text.trim().split("\n\n").filter(Boolean).map((frame) => {
    const id = frame.match(/^id: (\d+)$/m)?.[1];
    const type = frame.match(/^event: (.+)$/m)?.[1];
    const data = frame.match(/^data: (.+)$/m)?.[1];
    if (!id || !type || !data) throw new Error(`malformed AG-UI SSE frame: ${frame}`);
    return { sequence: Number(id), type, data: JSON.parse(data) as { messageId?: string } };
  });
}

function applySseReplay(...streams: string[]): SseEvent[] {
  const seen = new Set<number>();
  return streams.flatMap(sseEvents).filter((event) => {
    if (seen.has(event.sequence)) return false;
    seen.add(event.sequence);
    return true;
  });
}

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
      env: { ...process.env, NODE_ENV: "test", IRA_E2E_SESSION: "1", PORT: String(chatPort), IRA_RESEARCH_SERVICE_URL: researchBase, IRA_RUNTIME_DIR: runtimeDir }, stdio: ["ignore", "pipe", "inherit"],
    });
    const runtime = spawn(tsx, [path.resolve("apps/copilot-runtime/src/server.ts")], {
      env: { ...process.env, PORT: String(runtimePort), IRA_RESEARCH_SERVICE_URL: chatBase }, stdio: ["ignore", "pipe", "inherit"],
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
