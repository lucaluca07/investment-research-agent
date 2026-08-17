import { describe, expect, it } from "vitest";
import { closeInspector, openInspector } from "./inspector-state.js";

describe("inspector state", () => {
  it("opens discriminated targets and closes to null", () => {
    const target = openInspector({ kind: "artifact", id: "a1", title: "研究笔记", body: "完整正文" });
    expect(target?.kind).toBe("artifact");
    expect(closeInspector()).toBeNull();
  });
});
