import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, jsonl, piRows } from "./helpers.js";
import { DatabaseSync } from "node:sqlite";
import {
  readJsonl,
  readCursor,
  discover,
  normalize,
} from "../src/importers.js";
import { Store } from "../src/store.js";

test("pi/omp messages, native title, branches and PR provenance", (t) => {
  const home = fixture(t);
  const p = jsonl(home, "o.jsonl", [
    { type: "title", title: "Calendar export" },
    ...piRows(),
  ]);
  const c = readJsonl(p, "omp");
  assert.equal(c.title, "Calendar export");
  assert.deepEqual(
    c.messages.map((m) => m.role),
    ["user", "assistant", "tool"],
  );
  assert.ok(!JSON.stringify(c).includes("DO NOT INDEX"));
  assert.equal(c.branches[0].confidence, "mentioned");
  assert.equal(c.prs[0].url, "https://github.com/example/calendar/pull/42");
});
test("Codex metadata and duplicate event messages", (t) => {
  const p = jsonl(fixture(t), "c.jsonl", [
    {
      type: "session_meta",
      timestamp: "2026-01-01T00:00:00Z",
      payload: {
        id: "c",
        cwd: "/work/api",
        git: {
          branch: "fix/api",
          repository_url: "https://github.com/example/api",
        },
      },
    },
    {
      type: "event_msg",
      payload: { type: "user_message", message: "Fix timeout" },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Fix timeout" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        output: "https://github.com/example/api/pull/9",
      },
    },
  ]);
  const c = readJsonl(p, "codex");
  assert.equal(c.messages.length, 2);
  assert.equal(c.branches[0].confidence, "recorded");
  assert.ok(c.created_at);
  assert.equal(c.title, "Fix timeout");
});
test("event-only Codex and malformed tail", (t) => {
  const p = jsonl(fixture(t), "c.jsonl", [
    { type: "session_meta", payload: { id: "evt" } },
    {
      type: "event_msg",
      payload: { type: "user_message", message: "Add dark mode" },
    },
  ]);
  writeFileSync(p, readFileSync(p, "utf8") + '{"type":');
  const c = readJsonl(p, "codex");
  assert.equal(c.title, "Add dark mode");
  assert.equal(c.warnings, 1);
});
test("Cursor joins ordered split bubbles without writing source", (t) => {
  const home = fixture(t),
    p = join(home, "cursor.sqlite");
  const db = new DatabaseSync(p);
  db.exec(
    "CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value BLOB);CREATE TABLE composerHeaders(composerId TEXT PRIMARY KEY,value TEXT)",
  );
  const put = db.prepare("INSERT INTO cursorDiskKV VALUES (?,?)");
  put.run(
    "composerData:cur",
    JSON.stringify({
      composerId: "cur",
      createdAt: 1767225600000,
      fullConversationHeadersOnly: [{ bubbleId: "u" }, { bubbleId: "a" }],
    }),
  );
  put.run("bubbleId:cur:u", JSON.stringify({ type: 1, text: "Export events" }));
  put.run("bubbleId:cur:a", JSON.stringify({ type: 2, text: "Done" }));
  db.prepare("INSERT INTO composerHeaders VALUES (?,?)").run(
    "cur",
    JSON.stringify({
      name: "Calendar export",
      trackedGitRepos: [
        { repoPath: "/work/calendar", branches: ["feat/export"] },
      ],
    }),
  );
  db.close();
  const before = readFileSync(p);
  const chats = [...readCursor(p)];
  assert.equal(chats.length, 1);
  assert.equal(chats[0].title, "Calendar export");
  assert.equal(chats[0].cwd, "/work/calendar");
  assert.deepEqual(
    chats[0].messages.map((m) => m.text),
    ["Export events", "Done"],
  );
  assert.deepEqual(readFileSync(p), before);
});
test("discovery includes omp profiles and archived Codex", (t) => {
  const home = fixture(t);
  jsonl(home, ".omp/profiles/work/agent/sessions/a.jsonl", piRows());
  jsonl(home, ".codex/archived_sessions/c.jsonl", []);
  assert.deepEqual([...discover(home)].map((s) => s.harness).sort(), [
    "codex",
    "omp",
  ]);
});
test("stable IDs separate harnesses and do not depend on source path", () => {
  const msgs = [{ role: "user", text: "test", timestamp: "" }];
  assert.equal(
    normalize("pi", "s", "one", msgs).id,
    normalize("pi", "s", "two", msgs).id,
  );
  assert.notEqual(
    normalize("pi", "s", "one", msgs).id,
    normalize("omp", "s", "one", msgs).id,
  );
});
test("incremental index, literal search, pagination and FTS invalidation", (t) => {
  const home = fixture(t),
    p = jsonl(
      home,
      ".pi/agent/sessions/p.jsonl",
      piRows("Build wombat export"),
    );
  jsonl(home, ".omp/agent/sessions/o.jsonl", piRows());
  const store = new Store(join(home, "index.sqlite"));
  t.after(() => store.close());
  assert.equal(store.update(home).updated, 2);
  assert.equal(store.search("export").total, 2);
  assert.equal(store.search("feat/export", { harness: "pi" }).total, 1);
  assert.equal(store.search('\" ( : -').total, 0);
  assert.equal(store.search("", { limit: 1, offset: 1 }).items.length, 1);
  assert.equal(store.update(home).updated, 0);
  writeFileSync(
    p,
    piRows("Build rocket launch")
      .map((r) => JSON.stringify(r))
      .join("\n"),
  );
  store.update(home);
  assert.equal(store.search("wombat").total, 0);
  assert.equal(store.search("rocket").total, 1);
  assert.ok(!("messages" in store.search("rocket").items[0]));
  assert.throws(() => store.search("", { limit: 201 }));
});
test("partial truncation preserves indexed transcript, corrupt source isolated", (t) => {
  const home = fixture(t),
    p = jsonl(home, ".pi/agent/sessions/good.jsonl", piRows());
  jsonl(home, ".pi/agent/sessions/bad.jsonl", [false]);
  const store = new Store(join(home, "i.sqlite"));
  t.after(() => store.close());
  assert.equal(store.update(home).updated, 1);
  writeFileSync(p, JSON.stringify(piRows()[0]) + '\n{"type":');
  const stats = store.update(home);
  assert.equal(stats.updated, 0);
  assert.ok(stats.warnings);
  assert.equal(store.search("lunar").total, 1);
});
