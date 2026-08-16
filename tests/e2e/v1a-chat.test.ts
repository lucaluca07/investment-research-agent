import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../../apps/chat-backend/src/app.js";
import { FakeAgentSession } from "./fake-agent-session.js";
import { ResearchClient } from "../../apps/chat-backend/src/research-client.js";

type Backend = Awaited<ReturnType<typeof createApp>>;
type SseEvent = { id: number; type: string; data: Record<string, unknown> };

async function waitForHttp(url: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(url)).ok) return; } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not start: ${url}`);
}

async function readSse(url: string, lastEventId?: number, stopAfter = "message.completed"): Promise<SseEvent[]> {
  const controller = new AbortController();
  const headers = lastEventId === undefined ? {} : { "last-event-id": String(lastEventId) };
  const response = await fetch(url, { headers, signal: controller.signal });
  expect(response.ok).toBe(true);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      for (const frame of buffer.split("\n\n").slice(0, -1)) {
        const id = Number(frame.match(/^id: (\d+)$/m)?.[1]);
        const type = frame.match(/^event: (.+)$/m)?.[1];
        const data = frame.match(/^data: (.+)$/m)?.[1];
        if (Number.isFinite(id) && type && data) {
          events.push({ id, type, data: JSON.parse(data) as Record<string, unknown> });
          if (type === stopAfter) { controller.abort(); return events; }
        }
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n\n") + 2);
    }
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "AbortError") throw error;
  } finally { reader.releaseLock(); }
  return events;
}

async function startPython(dbPath: string, port: number): Promise<ChildProcess> {
  const python = join(process.cwd(), "services/research/.venv/bin/python");
  const child = spawn(python, ["tests/e2e/python_server.py", dbPath, String(port)], { cwd: process.cwd(), env: { ...process.env, PYTHONPATH: join(process.cwd(), "services/research") }, stdio: "ignore" });
  await waitForHttp(`http://127.0.0.1:${port}/v1/chats`);
  return child;
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child process did not exit")), 3000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

async function waitForSubscribers(backend: Backend, chatId: string, count: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (backend.chatRegistry.subscriberCount(chatId) === count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`subscriber count did not become ${count}`);
}

describe("V1a real HTTP crash recovery contract", () => {
  it("uses Python DuckDB and Chat Backend HTTP/SSE boundaries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ira-v1a-e2e-"));
    const dbPath = join(directory, "research.duckdb");
    const pythonPort = 18000 + Math.floor(Math.random() * 500);
    let python = await startPython(dbPath, pythonPort);
    const backendSessions: FakeAgentSession[] = [];
    const factorySessionIds: string[] = [];
    let backend: Backend | undefined;
    try {
      const clientBase = `http://127.0.0.1:${pythonPort}`;
      backend = await createApp({
        researchClient: new ResearchClient(clientBase),
        sessionFactory: async (sessionId) => { factorySessionIds.push(sessionId); const mode = backendSessions.length === 0 ? "success" : backendSessions.length === 1 ? "hang" : "error"; const session = new FakeAgentSession(sessionId, mode); backendSessions.push(session); return session; },
      });
      await backend.listen({ host: "127.0.0.1", port: 0 });
      const address = backend.server.address();
      const backendUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      const create = await fetch(`${backendUrl}/v1/chats`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(create.status).toBe(201);
      const chat = await create.json() as { id: string; pi_session_id: string };
      expect(chat.pi_session_id).not.toBe(chat.id);

      const send = await fetch(`${backendUrl}/v1/chats/${chat.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "research", idempotency_key: "e2e-stable" }) });
      expect(send.status).toBe(202);
      const disconnected = await readSse(`${backendUrl}/v1/chats/${chat.id}/events`, undefined, "message.delta");
      expect(disconnected.map((event) => event.type)).toContain("message.delta");
      await waitForSubscribers(backend, chat.id, 0);
      const lastId = disconnected.at(-1)!.id;
      const events = await readSse(`${backendUrl}/v1/chats/${chat.id}/events`, lastId, "run.status");
      expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["message.completed", "run.status"]));
      await waitForSubscribers(backend, chat.id, 0);
      const history = await (await fetch(`${backendUrl}/v1/chats/${chat.id}/messages`)).json() as { messages: Array<{ role: string; content: string }> };
      expect(history.messages.some((message) => message.role === "assistant" && message.content === "Victory Giant")).toBe(true);

      const replay = await readSse(`${backendUrl}/v1/chats/${chat.id}/events?lastEventId=${lastId}`, lastId, "run.status");
      expect(replay.map((event) => event.id)).toEqual([lastId + 1, lastId + 2]);
      expect((await (await fetch(`${backendUrl}/v1/chats`)).json() as Array<{ pi_session_id: string }>)[0]!.pi_session_id).toBe(chat.pi_session_id);

      const stopChat = await (await fetch(`${backendUrl}/v1/chats`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json() as { id: string };
      await (await fetch(`${backendUrl}/v1/chats/${stopChat.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "stop", idempotency_key: "stop-key" }) })).arrayBuffer();
      const running = await readSse(`${backendUrl}/v1/chats/${stopChat.id}/events`, undefined, "run.status");
      const runningId = running.at(-1)!.id;
      const stopped = await fetch(`${backendUrl}/v1/chats/${stopChat.id}/stop`, { method: "POST" });
      expect(stopped.status).toBe(200);
      const cancelled = await readSse(`${backendUrl}/v1/chats/${stopChat.id}/events`, runningId, "run.status");
      expect(cancelled.at(-1)?.data.status).toBe("cancelled");
      await waitForSubscribers(backend, stopChat.id, 0);

      const errorChat = await (await fetch(`${backendUrl}/v1/chats`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json() as { id: string };
      await (await fetch(`${backendUrl}/v1/chats/${errorChat.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "error", idempotency_key: "error-key" }) })).arrayBuffer();
      const errorEvents = await readSse(`${backendUrl}/v1/chats/${errorChat.id}/events`, undefined, "error");
      expect(errorEvents.at(-1)?.type).toBe("error");
      await waitForSubscribers(backend, errorChat.id, 0);
      await backend.close(); backend = undefined;
      python.kill("SIGTERM");
      await waitForExit(python);
      python = await startPython(dbPath, pythonPort);
      const restarted = await createApp({ researchClient: new ResearchClient(clientBase), sessionFactory: async (sessionId) => { factorySessionIds.push(sessionId); const session = new FakeAgentSession(sessionId, "success"); backendSessions.push(session); return session; } });
      await restarted.listen({ host: "127.0.0.1", port: 0 });
      const restartedAddress = restarted.server.address();
      const restartedUrl = `http://127.0.0.1:${typeof restartedAddress === "object" && restartedAddress ? restartedAddress.port : 0}`;
      const restored = await (await fetch(`${restartedUrl}/v1/chats`)).json() as Array<{ id: string; pi_session_id: string }>;
      expect(restored).toContainEqual({ id: chat.id, pi_session_id: chat.pi_session_id });
      const replayed = await fetch(`${restartedUrl}/v1/chats/${chat.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "research", idempotency_key: "e2e-stable" }) });
      expect(replayed.status).toBe(200);
      expect(factorySessionIds.at(-1)).toBe(chat.pi_session_id);
      await restarted.close();
    } finally {
      await backend?.close();
      python.kill("SIGTERM");
      await waitForExit(python);
      await rm(directory, { recursive: true, force: true });
    }
  }, 15000);
});
