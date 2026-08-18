import http from "node:http";

const port = Number(process.argv[2] ?? 0);
let sequence = 0;
const events = new Map<string, Array<{ sequence: number; type: string; data: unknown }>>();

function write(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const match = url.pathname.match(/^\/v1\/threads\/([^/]+)\/(runs|events)$/);
  if (!match) return write(res, 404, { detail: "not found" });
  const thread = decodeURIComponent(match[1]!);
  if (req.method === "POST" && match[2] === "runs") {
    const list = events.get(thread) ?? [];
    if (!list.length) {
      const runId = `run-${thread}`;
      for (const [type, data] of [
        ["RUN_STARTED", { type: "RUN_STARTED", runId }],
        ["TEXT_MESSAGE_CONTENT", { type: "TEXT_MESSAGE_CONTENT", messageId: "assistant-1", delta: "fixture" }],
        ["RUN_FINISHED", { type: "RUN_FINISHED", runId }],
      ] as const) list.push({ sequence: ++sequence, type, data });
      events.set(thread, list);
    }
    return write(res, 200, { run_id: `run-${thread}`, last_event_seq: 0 });
  }
  if (req.method === "GET" && match[2] === "events") {
    const after = Number(url.searchParams.get("after") ?? 0);
    return write(res, 200, (events.get(thread) ?? []).filter((event) => event.sequence > after));
  }
  return write(res, 405, { detail: "method not allowed" });
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`READY:${typeof address === "object" && address ? address.port : port}\n`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
