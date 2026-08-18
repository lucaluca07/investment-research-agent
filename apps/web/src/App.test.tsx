// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import type { ChatApi } from "./lib/chat-api.js";
import { createChatApi } from "./lib/chat-api.js";
import type { WorkbenchRuntime } from "./App.js";

function fakeApi(): ChatApi { return { listChats: vi.fn().mockResolvedValue([]), createChat: vi.fn().mockResolvedValue({ id: "chat-1", pi_session_id: "pi-1" }), getMessages: vi.fn().mockResolvedValue({ messages: [] }), sendMessage: vi.fn().mockResolvedValue({ runId: "run-1" }), stop: vi.fn(), subscribe: vi.fn().mockReturnValue(() => {}) }; }

describe("web chat", () => {
  afterEach(() => cleanup());
  it("loads an empty chat shell and new chat control", async () => { render(<App api={fakeApi()} />); expect(await screen.findByText("开始一项研究")).toBeTruthy(); expect(screen.getByRole("button", { name: "新建 chat" })).toBeTruthy(); });

  it("loads an existing chat and handles named stream events, reconnect, dedupe, and stop failure", async () => {
    let onEvent: ((event: any) => void) | undefined; let onConnection: ((connected: boolean) => void) | undefined;
    const api = fakeApi(); api.listChats = vi.fn().mockResolvedValue([{ id: "history", pi_session_id: "pi" }]); api.subscribe = vi.fn((_id, event, connection) => { onEvent = event; onConnection = connection; return () => {}; }); api.stop = vi.fn().mockRejectedValue(new Error("stop"));
    render(<App api={api} />); expect(await screen.findByRole("button", { name: "history" })).toBeTruthy(); await waitFor(() => expect(api.subscribe).toHaveBeenCalled());
    onEvent?.({ id: 1, type: "RUN_STARTED", data: { run_id: "run-1" } });
    onEvent?.({ id: 2, type: "TOOL_CALL_RESULT", data: { tool_name: "query_company_snapshot" } });
    onEvent?.({ id: 3, type: "TEXT_MESSAGE_CONTENT", data: { messageId: "message-1", delta: "胜宏" } });
    onEvent?.({ id: 4, type: "TEXT_MESSAGE_CONTENT", data: { messageId: "message-1", delta: "科技" } });
    onEvent?.({ id: 5, type: "citation", data: { document_id: "doc-1", published_at: "2026-08-14", locator: "unsafe" } });
    onConnection?.(false); onConnection?.(true);
    expect(await screen.findByText("胜宏科技")).toBeTruthy(); expect(screen.getByRole("link", { name: /2026-08-14/ }).getAttribute("href")).toBe("#citation-doc-1");
    expect(api.getMessages).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("停止失败"));
  });

  it("uses named EventSource listeners and Last-Event-ID dedupe", () => {
    const listeners: Record<string, (event: MessageEvent) => void> = {};
    const source = { addEventListener: (name: string, callback: (event: MessageEvent) => void) => { listeners[name] = callback; }, close: vi.fn() } as unknown as EventSource;
    const factory = vi.fn().mockReturnValue(source);
    const api = createChatApi(vi.fn() as never, factory);
    const received: any[] = [];
    const dispose = api.subscribe("chat-1", (event) => received.push(event), vi.fn());
    expect(factory).toHaveBeenCalledWith("/v1/threads/chat-1/events");
    expect(listeners["TEXT_MESSAGE_CONTENT"]).toBeTypeOf("function");
    listeners["TEXT_MESSAGE_CONTENT"](new MessageEvent("TEXT_MESSAGE_CONTENT", { data: JSON.stringify({ messageId: "message-1", delta: "A" }), lastEventId: "7" }));
    listeners["message.completed"](new MessageEvent("message.completed", { data: JSON.stringify({ run_id: "run-1", message_id: "message-1", content: "A" }), lastEventId: "8" }));
    listeners["message.completed"](new MessageEvent("message.completed", { data: JSON.stringify({ run_id: "run-1", message_id: "message-1", content: "A" }), lastEventId: "8" }));
    expect(received.map((event) => event.type)).toEqual(["TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END"]);
    dispose(); expect(source.close).toHaveBeenCalled();
  });

  it("reconnects with the last event cursor and replaces one assistant message", async () => {
    const sources: Array<{ addEventListener: (name: string, callback: (event: MessageEvent) => void) => void; onerror?: () => void; close: () => void }> = [];
    const factory = vi.fn().mockImplementation(() => { const source = { addEventListener: vi.fn(), close: vi.fn() }; sources.push(source); return source; });
    const api = createChatApi(vi.fn() as never, factory);
    const received: any[] = []; const dispose = api.subscribe("chat-1", (event) => received.push(event), vi.fn());
    const firstListener = sources[0]!.addEventListener as ReturnType<typeof vi.fn>;
    const delta = firstListener.mock.calls.find(([name]) => name === "message.delta")![1];
    delta({ lastEventId: "9", data: JSON.stringify({ run_id: "run-1", delta: "草稿" }) });
    sources[0]!.onerror?.();
    await new Promise((resolve) => setTimeout(resolve, 280));
    expect(factory).toHaveBeenCalledTimes(2);
    expect((factory.mock.calls[1] as string[])[0]).toContain("lastEventId=9");
    dispose(); expect(received).toHaveLength(1);
  });

  it("shows loading and chat-list failure states", async () => {
    const api = fakeApi(); api.listChats = vi.fn(() => new Promise<Array<{ id: string; pi_session_id: string }>>(() => undefined)); render(<App api={api} />); expect(screen.getByRole("status").textContent).toContain("加载中");
    cleanup(); const failing = fakeApi(); failing.listChats = vi.fn().mockRejectedValue(new Error("offline")); render(<App api={failing} />); expect((await screen.findByRole("alert")).textContent).toContain("无法加载 chat 列表");
  });

  it("renders persisted assistant completion exactly once with tool, citation, run, and error events", async () => {
    let onEvent: ((event: any) => void) | undefined; const api = fakeApi(); api.listChats = vi.fn().mockResolvedValue([{ id: "chat-1", pi_session_id: "pi" }]); api.getMessages = vi.fn().mockResolvedValue({ messages: [{ id: "message-1", role: "assistant", content: "完整答案" }] }); api.subscribe = vi.fn((_id, event) => { onEvent = event; return () => {}; });
    render(<App api={api} />); await screen.findByRole("button", { name: "chat-1" }); onEvent?.({ id: 1, type: "run.status", data: { status: "running" } }); onEvent?.({ id: 2, type: "tool.completed", data: { tool_name: "snapshot" } }); onEvent?.({ id: 3, type: "message.delta", data: { run_id: "run-1", delta: "草稿" } }); onEvent?.({ id: 4, type: "message.completed", data: { run_id: "run-1", message_id: "message-1", content: "完整答案" } }); onEvent?.({ id: 5, type: "citation", data: { document_id: "doc", published_at: "2026-08-14" } }); onEvent?.({ id: 6, type: "run.status", data: { status: "succeeded" } }); expect(await screen.findByText("完整答案")).toBeTruthy(); expect(screen.getAllByText("完整答案")).toHaveLength(1); expect(screen.getByRole("link", { name: /2026-08-14/ })).toBeTruthy(); onEvent?.({ id: 7, type: "error", data: { message: "网络错误" } }); await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("网络错误"));
  });

  it("stops successfully without an error and returns to send state", async () => {
    let onEvent: ((event: any) => void) | undefined; const api = fakeApi(); api.listChats = vi.fn().mockResolvedValue([{ id: "chat-stop", pi_session_id: "pi" }]); api.subscribe = vi.fn((_id, event) => { onEvent = event; return () => {}; }); api.stop = vi.fn().mockResolvedValue(undefined);
    render(<App api={api} />); await screen.findByRole("button", { name: "chat-stop" }); await waitFor(() => expect(api.subscribe).toHaveBeenCalled()); onEvent?.({ id: 1, type: "run.status", data: { run_id: "run-stop", status: "running" } }); await waitFor(() => expect(screen.getByRole("button", { name: "停止" })).toBeTruthy()); fireEvent.click(screen.getByRole("button", { name: "停止" })); await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeTruthy()); expect(api.stop).toHaveBeenCalledWith("chat-stop"); expect(screen.queryByRole("alert")).toBeNull();
  });

  it("clears event-derived inspector records when switching threads", async () => {
    let onEvent: ((event: any) => void) | undefined; const api = fakeApi();
    api.listChats = vi.fn().mockResolvedValue([{ id: "thread-a", pi_session_id: "a" }, { id: "thread-b", pi_session_id: "b" }]);
    api.subscribe = vi.fn((_id, event) => { onEvent = event; return () => {}; });
    render(<App api={api} />); await screen.findByRole("button", { name: "thread-b" });
    onEvent?.({ id: 1, type: "citation", data: { document_id: "doc-a", published_at: "2026-08-14" } });
    expect(await screen.findByRole("link", { name: "2026-08-14" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "thread-b" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "2026-08-14" })).toBeNull());
  });

  it("accepts artifact, approval and interrupt data from the runtime adapter", async () => {
    const resolve = vi.fn();
    const runtime: WorkbenchRuntime = {
      threadId: "runtime-thread",
      inspectorRecords: [
        { kind: "artifact", id: "report-1", title: "PCB 报告", body: "报告正文", version: "v1" },
        { kind: "approval", id: "approval-1", runId: "run-1", impact: "保存报告", decision: "待处理" },
      ],
      interrupts: [{ runId: "run-1", interruptId: "approval-1", schema: { properties: { ticker: { type: "string" } } } }],
      onResolveInterrupt: resolve,
      onCancelInterrupt: vi.fn(),
      onRefreshInterrupts: vi.fn(),
    };
    const api = fakeApi(); api.listChats = vi.fn().mockResolvedValue([{ id: "runtime-thread", pi_session_id: "pi" }]);
    render(<App api={api} runtime={runtime} />); await screen.findByText("开始一项研究");
    fireEvent.click(screen.getByRole("button", { name: "PCB 报告" })); expect(screen.getByText("报告正文")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("ticker"), { target: { value: "300476.SZ" } });
    fireEvent.click(screen.getByRole("button", { name: "批准" }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(expect.anything(), { approved: true, ticker: "300476.SZ" }));
  });

  it("hides runtime artifacts and interrupts after switching to another thread", async () => {
    const api = fakeApi(); api.listChats = vi.fn().mockResolvedValue([{ id: "thread-a", pi_session_id: "a" }, { id: "thread-b", pi_session_id: "b" }]);
    const runtime: WorkbenchRuntime = {
      threadId: "thread-a",
      inspectorRecords: [{ kind: "artifact", id: "a-report", title: "A 线程报告", body: "A 正文" }],
      interrupts: [{ runId: "run-a", interruptId: "approval-a" }],
      onResolveInterrupt: vi.fn(), onCancelInterrupt: vi.fn(), onRefreshInterrupts: vi.fn(),
    };
    render(<App api={api} runtime={runtime} />); await screen.findByRole("button", { name: "thread-b" });
    expect(screen.getByRole("button", { name: "A 线程报告" })).toBeTruthy();
    expect(screen.getByLabelText("待处理审批")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "thread-b" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "A 线程报告" })).toBeNull());
    expect(screen.queryByLabelText("待处理审批")).toBeNull();
    expect(screen.getByRole("button", { name: "发送" })).toBeTruthy();
  });
});
