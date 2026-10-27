import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  callBackend,
  enrich,
  makePrompt,
  validateResult,
} from "../src/enrich.js";
import { normalize } from "../src/importers.js";
import { Store } from "../src/store.js";
import { fixture } from "./helpers.js";
const command = (code) => ({ command: [process.execPath, "-e", code] });
const config = (code) => ({ harnesses: { safe: command(code) } });
const fakeCode =
  'let p="";process.stdin.on("data",x=>p+=x);process.stdin.on("end",()=>console.log(JSON.stringify({title:"Moon phases",summary:p.includes("Build lunar")?"Calendar work":"BAD"})))';
function storeFixture(t) {
  const s = new Store(join(fixture(t), "i.sqlite"));
  t.after(() => s.close());
  const chat = normalize("pi", "s", "test.jsonl", [
    { role: "user", text: "Build lunar export", timestamp: "" },
  ]);
  s.upsert(chat);
  return { s, chat };
}

test("harness receives prompt on stdin and summaries cache by backend/content", async (t) => {
  const { s, chat } = storeFixture(t);
  let stats = await enrich(s, config(fakeCode), "safe", "harness");
  assert.equal(stats.summarized, 1);
  assert.equal(s.get(chat.id).summary, "Calendar work");
  assert.equal(s.search("Moon phases").total, 1);
  assert.equal(
    (await enrich(s, config(fakeCode), "safe", "harness")).cached,
    1,
  );
  const cfg = config(
    'console.log(JSON.stringify({title:"Other title",summary:"Changed backend"}))',
  );
  assert.equal((await enrich(s, cfg, "safe", "harness")).summarized, 1);
  s.upsert(
    normalize("pi", "s", "test.jsonl", [
      { role: "user", text: "Solar export", timestamp: "" },
    ]),
  );
  assert.equal(s.get(chat.id).summary_kind, "local");
  assert.equal(s.search("Changed backend").total, 0);
});
test("bad harness output preserves local summary and errors hide stderr", async (t) => {
  const { s, chat } = storeFixture(t);
  const result = await enrich(
    s,
    config('console.error("SECRET");process.exit(1)'),
    "safe",
    "harness",
  );
  assert.equal(result.failed, 1);
  assert.ok(!JSON.stringify(result).includes("SECRET"));
  assert.equal(s.get(chat.id).summary_kind, "local");
  await assert.rejects(() => enrich(s, {}, "missing", "harness"));
});
test("bounded prompts exclude tools and preserve ending", () => {
  const prompt = makePrompt({
    messages: [
      { role: "tool", text: "TOOL SECRET" },
      { role: "user", text: "A".repeat(100000) },
      { role: "assistant", text: "Ending result" },
    ],
  });
  assert.ok(prompt.length < 26000);
  assert.ok(!prompt.includes("TOOL SECRET"));
  assert.ok(prompt.includes("Ending result"));
});
test("AI result validation rejects extra keys, blank and wrong typed fields", () => {
  for (const value of [
    {},
    { title: [], summary: "ok" },
    { title: "x", summary: "" },
    { title: "x", summary: "y", messages: [] },
  ])
    assert.throws(() => validateResult(value));
});
test("provider protocols set redirect rejection and support JSON fences", async () => {
  for (const type of ["openai", "anthropic"]) {
    let request;
    const body = '```json\n{"title":"Good","summary":"Done"}\n```';
    const fetchImpl = async (url, opts) => {
      request = { url, opts };
      return new Response(
        JSON.stringify(
          type === "anthropic"
            ? { content: [{ type: "text", text: body }] }
            : { choices: [{ message: { content: body } }] },
        ),
      );
    };
    const result = await callBackend(
      { type, url: "https://example.test/api", model: "test" },
      "provider",
      "TEST PROMPT",
      fetchImpl,
    );
    assert.equal(result.title, "Good");
    assert.equal(request.opts.redirect, "error");
    assert.ok(request.opts.body.includes("TEST PROMPT"));
  }
});
test("provider rejects insecure endpoints and URL credentials before network", async () => {
  for (const url of ["http://example.test", "https://user:pass@example.test"])
    await assert.rejects(
      () =>
        callBackend({ url, model: "m" }, "provider", "prompt", () => {
          throw new Error("must not call");
        }),
      /HTTPS|credentials/,
    );
});
