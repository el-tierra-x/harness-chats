import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { after } from "node:test";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
// Register at module scope: after() called inside a test attaches to that test,
// which could delete its directory before later SQLite/server close hooks run.
const homes = [];
after(() => {
  for (const home of homes) {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
export function fixture() {
  const home = mkdtempSync(join(tmpdir(), "harness-chats-test-"));
  homes.push(home);
  return home;
}
export function jsonl(home, path, rows) {
  const p = join(home, path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}
export function piRows(text = "Build lunar export", id = "same") {
  return [
    {
      type: "session",
      id,
      cwd: "/work/calendar",
      timestamp: "2026-01-01T00:00:00Z",
    },
    {
      type: "message",
      message: { role: "user", content: [{ type: "text", text }] },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "DO NOT INDEX" },
          { type: "text", text: "Implemented export." },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        content: [
          {
            type: "text",
            text: "git checkout -b feat/export\nhttps://github.com/example/calendar/pull/42",
          },
        ],
      },
    },
  ];
}
