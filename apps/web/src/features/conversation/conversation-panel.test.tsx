// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConversationPanel } from "./conversation-panel.js";
it("disables sending while running and exposes stop", () => { render(<ConversationPanel messages={[]} draft="question" onDraftChange={vi.fn()} onSend={vi.fn()} onStop={vi.fn()} running />); expect(screen.queryByRole("button", { name: "发送" })).toBeNull(); expect(screen.getByRole("button", { name: "停止" })).toBeTruthy(); expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(true); });
