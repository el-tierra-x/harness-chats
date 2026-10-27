// Optional real-browser smoke test. Uses installed Chrome, Node 22+, no npm dependencies.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Store } from "../src/store.js";
import { normalize } from "../src/importers.js";

const chromePath =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = await mkdtemp(join(tmpdir(), "harness-chats-chrome-"));
let server, chrome, ws;
const pending = new Map();
let seq = 0;
function lineMatching(stream, regex) {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: stream });
    const timer = setTimeout(() => {
      lines.close();
      reject(new Error("Startup timed out"));
    }, 20000);
    lines.on("line", (line) => {
      const match = line.match(regex);
      if (match) {
        clearTimeout(timer);
        lines.close();
        resolve(match[1]);
      }
    });
    lines.on("close", () => clearTimeout(timer));
  });
}
function call(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(method + " timed out"));
    }, 20000);
    pending.set(id, (result) => {
      clearTimeout(timer);
      result.error
        ? reject(new Error(JSON.stringify(result.error)))
        : resolve(result.result);
    });
    ws.send(
      JSON.stringify({
        id,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      }),
    );
  });
}
try {
  const dbPath = join(profile, "index.sqlite"),
    store = new Store(dbPath);
  for (const harness of ["pi", "codex"])
    store.upsert(
      normalize(harness, harness, "synthetic.jsonl", [
        {
          role: "user",
          text: "Build calendar export <script>window.__unsafe=true</script>",
          timestamp: "",
        },
        {
          role: "assistant",
          text: "Use git checkout -b feat/export. PR: https://github.com/example/calendar/pull/42",
          timestamp: "",
        },
      ]),
    );
  store.close();
  server = spawn(
    process.execPath,
    ["bin/chats.js", "serve", "--db", dbPath, "--port", "0"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  server.stderr.resume();
  const url = await lineMatching(
    server.stdout,
    /Harness Chats: (http:\/\/\S+)/,
  );
  chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      "--user-data-dir=" + profile,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const endpoint = await lineMatching(
    chrome.stderr,
    /DevTools listening on (ws:\/\/\S+)/,
  );
  chrome.stderr.resume();
  ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    const fn = pending.get(msg.id);
    if (fn) {
      pending.delete(msg.id);
      fn(msg);
    }
  });
  const { targetId } = await call("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId } = await call("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const evaluate = async (expression) => {
    const result = await call(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const wait = async (expression) =>
    evaluate(
      `new Promise((resolve,reject)=>{const end=Date.now()+10000;const check=()=>{if(${expression})resolve(true);else if(Date.now()>end)reject(new Error('UI condition timed out'));else setTimeout(check,25)};check()})`,
    );
  await call("Page.navigate", { url }, sessionId);
  await wait("document.querySelectorAll('#results .card').length > 0");
  const cards = await evaluate(
    "document.querySelectorAll('#results .card').length",
  );
  await evaluate("document.querySelector('#results .card').click()");
  await wait("document.querySelector('#detail .detail-head') !== null");
  const detail = await evaluate(
    "({messages:document.querySelectorAll('#detail .message').length,source:!!document.querySelector('#detail details'),summary:!!document.querySelector('#detail .detail-head p'),prLinks:document.querySelectorAll('#detail .refs a').length,safe:!window.__unsafe})",
  );
  if (detail.messages !== 2 || detail.prLinks !== 1 || !detail.safe)
    throw new Error("Transcript, PR link or escaping failed");
  await evaluate(
    "document.getElementById('harness').value='pi';document.getElementById('harness').dispatchEvent(new Event('change'))",
  );
  await wait(
    "document.getElementById('status').textContent.includes('conversations') && [...document.querySelectorAll('#results .badge')].every(x=>x.textContent==='PI')",
  );
  await evaluate(
    "document.getElementById('query').value='zznonexistenttokenzz';document.getElementById('search').dispatchEvent(new Event('submit',{cancelable:true}))",
  );
  await wait(
    "document.getElementById('status').textContent.startsWith('0 conversations')",
  );
  console.log(
    JSON.stringify({
      browser: "Chrome headless",
      initialCards: cards,
      detail,
      harnessFilter: true,
      emptySearch: true,
    }),
  );
} finally {
  ws?.close();
  for (const process of [chrome, server]) {
    if (process && process.exitCode === null) {
      const exited = new Promise((resolve) => process.once("exit", resolve));
      process.kill("SIGTERM");
      await exited;
    }
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
