import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { once } from "node:events";
import { get as httpGet } from "node:http";
import { spawnSync } from "node:child_process";
import { createServer } from "../src/web.js";
import { Store } from "../src/store.js";
import { normalize } from "../src/importers.js";
import { fixture, jsonl, piRows } from "./helpers.js";
const cli = (args) =>
  spawnSync(process.execPath, ["bin/chats.js", ...args], { encoding: "utf8" });

test("CLI index/update/search support options and JSON", (t) => {
  const home = fixture(t),
    db = join(home, "i.sqlite");
  jsonl(home, ".pi/agent/sessions/p.jsonl", piRows());
  let p = cli(["index", "--home", home, "--db", db]);
  assert.equal(p.status, 0, p.stderr);
  assert.equal(JSON.parse(p.stdout).updated, 1);
  p = cli(["--db", db, "update", "--home", home]);
  assert.equal(p.status, 0, p.stderr);
  assert.equal(JSON.parse(p.stdout).updated, 0);
  p = cli(["search", "lunar", "--json", "--db", db]);
  assert.equal(p.status, 0, p.stderr);
  assert.equal(JSON.parse(p.stdout).total, 1);
});
test("CLI validates opt-in, harnesses, limits and unknown commands", (t) => {
  const db = join(fixture(t), "i.sqlite");
  for (const args of [
    ["update", "--ai-summarize"],
    ["update", "--provider", "named"],
    ["update", "--force-ai"],
    ["search", "x", "--harness", "bad"],
    ["search", "--limit", "no"],
    ["unknown"],
  ]) {
    const p = cli(["--db", db, ...args]);
    assert.notEqual(p.status, 0);
    assert.match(p.stderr, /chats:/);
  }
});
test("HTTP search/details, fixed assets, validation and origin controls", async (t) => {
  const path = join(fixture(t), "i.sqlite"),
    store = new Store(path);
  const chat = normalize("pi", "s", "/not-public.jsonl", [
    {
      role: "user",
      text: "<script>alert(1)</script> lunar export",
      timestamp: "",
    },
  ]);
  store.upsert(chat);
  store.close();
  const server = createServer(path);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  let res = await fetch(base + "/api/chats?q=lunar");
  const list = await res.json();
  assert.equal(list.total, 1);
  assert.ok(!("messages" in list.items[0]));
  res = await fetch(base + "/api/chat?id=" + chat.id);
  assert.ok((await res.json()).messages[0].text.includes("<script>"));
  res = await fetch(base);
  assert.match(await res.text(), /Harness Chats/);
  assert.match(
    res.headers.get("content-security-policy"),
    /default-src 'self'/,
  );
  for (const [path, status] of [
    ["/api/chat?id=missing", 404],
    ["/api/chats?limit=no", 400],
    ["/api/chats?limit=999", 400],
    ["/not-public.jsonl", 404],
    ["/../../etc/passwd", 404],
  ]) {
    res = await fetch(base + path);
    assert.equal(res.status, status);
    await res.text();
  }
  // Node fetch overwrites Host; use the raw HTTP client to test DNS-rebinding protection.
  for (const headers of [
    { host: "evil.example" },
    { origin: "https://evil.example" },
    { "sec-fetch-site": "cross-site" },
  ]) {
    const status = await new Promise((resolve, reject) => {
      httpGet(base + "/api/chats", { headers }, (r) => {
        r.resume();
        r.on("end", () => resolve(r.statusCode));
      }).on("error", reject);
    });
    assert.equal(status, 403);
  }
  res = await fetch(base + "/api/chats", { method: "POST" });
  assert.equal(res.status, 405);
  await res.text();
});
