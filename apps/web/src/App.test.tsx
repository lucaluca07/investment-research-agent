// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import type { ChatApi } from "./lib/chat-api.js";

function fakeApi(): ChatApi { return { listChats: vi.fn().mockResolvedValue([]), createChat: vi.fn().mockResolvedValue({ id: "chat-1", pi_session_id: "pi-1" }), getMessages: vi.fn().mockResolvedValue({ messages: [] }), sendMessage: vi.fn().mockResolvedValue({ runId: "run-1" }), stop: vi.fn(), subscribe: vi.fn().mockReturnValue(() => {}) }; }

describe("web chat", () => {
  it("loads an empty chat shell and new chat control", async () => { render(<App api={fakeApi()} />); expect(await screen.findByText("开始一项研究")).toBeTruthy(); expect(screen.getByRole("button", { name: "新建 chat" })).toBeTruthy(); });

  it("loads an existing chat and handles named stream events, reconnect, dedupe, and stop failure", async () => {
    let onEvent: ((event: any) => void) | undefined; let onConnection: ((connected: boolean) => void) | undefined;
    const api = fakeApi(); api.listChats = vi.fn().mockResolvedValue([{ id: "history", pi_session_id: "pi" }]); api.subscribe = vi.fn((_id, event, connection) => { onEvent = event; onConnection = connection; return () => {}; }); api.stop = vi.fn().mockRejectedValue(new Error("stop"));
    render(<App api={api} />); expect(await screen.findByRole("button", { name: "history" })).toBeTruthy();
    onEvent?.({ id: 1, type: "run.status", data: { run_id: "run-1", status: "running" } });
    onEvent?.({ id: 2, type: "tool.completed", data: { tool_name: "query_company_snapshot" } });
    onEvent?.({ id: 3, type: "message.delta", data: { run_id: "run-1", delta: "胜宏" } });
    onEvent?.({ id: 4, type: "message.delta", data: { run_id: "run-1", delta: "科技" } });
    onEvent?.({ id: 5, type: "citation", data: { document_id: "doc-1", published_at: "2026-08-14", locator: "unsafe" } });
    onConnection?.(false); onConnection?.(true);
    expect(await screen.findByText("胜宏科技")).toBeTruthy(); expect(screen.getByRole("link", { name: /2026-08-14/ }).getAttribute("href")).toBe("#citation-doc-1");
    expect(api.getMessages).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("停止失败"));
  });
});
