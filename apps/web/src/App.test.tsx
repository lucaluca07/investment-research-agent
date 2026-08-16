// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import type { ChatApi } from "./lib/chat-api.js";

function fakeApi(): ChatApi { return { listChats: vi.fn().mockResolvedValue([]), createChat: vi.fn().mockResolvedValue({ id: "chat-1", pi_session_id: "pi-1" }), getMessages: vi.fn().mockResolvedValue({ messages: [] }), sendMessage: vi.fn().mockResolvedValue({ runId: "run-1" }), stop: vi.fn(), subscribe: vi.fn().mockReturnValue(() => {}) }; }

describe("web chat", () => {
  it("loads an empty chat shell and new chat control", async () => { render(<App api={fakeApi()} />); expect(await screen.findByText("开始一项研究")).toBeTruthy(); expect(screen.getByRole("button", { name: "新建 chat" })).toBeTruthy(); });
});
