import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The desktop agent's health and finance tools (ADR-0099) are answered by
 * the app over its local proxy, never read from SQLite here, so the computer
 * and the phones say the same figures. Advertised only with the proxy
 * coordinates, like the calendar. Plain JavaScript for the child process,
 * like june-context-mcp.test.mjs.
 */

const SCRIPT = `
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import june_context_mcp as m
calls = []
def fake_proxy(coords, path, payload):
    calls.append([coords, path, payload])
    return {"answered": path}
m.call_proxy = fake_proxy
db = Path(sys.argv[2])
def names(proxy):
    listed = m.handle_message(db, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, True, proxy)
    return [tool["name"] for tool in listed["result"]["tools"]]
out = {"without": names(""), "with": names("/coords.json")}
def call(name, arguments, proxy="/coords.json"):
    return m.handle_message(db, {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": name, "arguments": arguments}}, True, proxy)
out["health"] = call("health_summary", {"days": 7, "metrics": None})["result"]["structuredContent"]
out["spending"] = call("spending_summary", {"from": "2026-09-01"})["result"]["structuredContent"]
out["search"] = call("transactions_search", {"query": "coop", "max_amount": -10})["result"]["structuredContent"]
out["noProxy"] = call("health_summary", {}, "")
out["calls"] = calls
print(json.dumps(out))
`;

function runPython() {
  const dir = mkdtempSync(join(tmpdir(), "june-mcp-personal-"));
  const script = join(dir, "drive.py");
  writeFileSync(script, SCRIPT);
  try {
    const stdout = execFileSync(
      "python3",
      [script, join(process.cwd(), "src-tauri/src/hermes"), join(dir, "notes.sqlite3")],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return JSON.parse(stdout);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

describe("june_context_mcp health and finances", () => {
  const result = runPython();
  const maybe = result ? it : it.skip;

  maybe("are offered only with the proxy that answers them", () => {
    for (const name of ["health_summary", "spending_summary", "transactions_search"]) {
      expect(result.without).not.toContain(name);
      expect(result.with).toContain(name);
    }
    expect(result.noProxy.error.code).toBe(-32602);
  });

  maybe("ask the app over its proxy, without empty arguments", () => {
    expect(result.health).toEqual({ answered: "/health/summary" });
    expect(result.spending).toEqual({ answered: "/finance/spending" });
    expect(result.search).toEqual({ answered: "/finance/transactions" });
    expect(result.calls).toEqual([
      ["/coords.json", "/health/summary", { days: 7 }],
      ["/coords.json", "/finance/spending", { from: "2026-09-01" }],
      ["/coords.json", "/finance/transactions", { query: "coop", max_amount: -10 }],
    ]);
  });
});
