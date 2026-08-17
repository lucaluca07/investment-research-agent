import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = resolve(import.meta.dirname, "../../../scripts/dev-v1a.sh");

describe("dev-v1a startup script", () => {
  it("starts uvicorn through the project virtual environment", async () => {
    const script = await readFile(scriptPath, "utf8");

    expect(script).toContain('RESEARCH_PYTHON="$ROOT_DIR/services/research/.venv/bin/python"');
    expect(script).toContain('"$RESEARCH_PYTHON" -m uvicorn');
  });

  it("does not require wait -n, which macOS Bash 3.2 lacks", async () => {
    const script = await readFile(scriptPath, "utf8");

    expect(script).not.toMatch(/\bwait\s+-n\b/);
  });

  it("configures the backend through the PORT environment variable", async () => {
    const script = await readFile(scriptPath, "utf8");

    expect(script).toContain("PORT=8020");
    expect(script).not.toContain("dev -- --host 127.0.0.1 --port 8020");
  });

  it("passes Vite host and port arguments without a literal separator", async () => {
    const script = await readFile(scriptPath, "utf8");

    expect(script).toContain("dev --host 127.0.0.1 --port 5173");
    expect(script).not.toContain("dev -- --host 127.0.0.1 --port 5173");
  });
});
