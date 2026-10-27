import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Store, DEFAULT_DB, expandPath } from "./store.js";
import { HARNESSES } from "./importers.js";

const HELP = `Harness Chats — local conversation search across Codex, Cursor, pi and omp

Usage: chats <command> [options]

Commands:
  index                 Import local chat histories into SQLite
  update                Incremental alias for index
  search [words]        Search titles, summaries, transcripts, branches and PRs
  serve                 Run the local browser app at http://127.0.0.1:8765

Global options:
  --db PATH             Index path (default: ~/.local/share/harness-chats/index.sqlite)
  -h, --help            Show help
  -v, --version         Print version

index / update:
  --home PATH           Home containing histories (default: your home directory)
  --only HARNESS        Import/summarize one source harness
  --ai-summarize        Explicitly enable AI summarization
  --provider NAME       Named provider in configuration
  --harness NAME        Named trusted, tools-disabled harness command
  --config PATH         Config file (default: ~/.config/harness-chats/config.json)
  --force-ai            Regenerate cached AI summaries

search:
  --harness NAME        Filter by codex, cursor, pi or omp
  --repo PATH_OR_URL    Exact repository filter
  --limit N             1..200 (default: 50)
  --offset N            Pagination offset (default: 0)
  --json                Print structured JSON

serve:
  --port N              Loopback port (default: 8765)
  --open                Open the default browser

Examples:
  chats index
  chats update --only pi
  chats search "calendar export" --harness codex
  chats serve --open
  chats update --ai-summarize --provider local-model

AI is never called unless explicitly enabled. See README.md for setup and privacy.
`;
const stringOptions = [
  "db",
  "home",
  "only",
  "provider",
  "harness",
  "config",
  "repo",
  "limit",
  "offset",
  "port",
];
const booleanOptions = ["ai-summarize", "force-ai", "json", "open"];
const COMMON = ["db", "help", "version"];
const ALLOWED = {
  index: [
    ...COMMON,
    "home",
    "only",
    "ai-summarize",
    "provider",
    "harness",
    "config",
    "force-ai",
  ],
  search: [...COMMON, "harness", "repo", "limit", "offset", "json"],
  serve: [...COMMON, "port", "open"],
};
const output = (value) => console.log(JSON.stringify(value, null, 2));
function integer(value, fallback, min, max) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error(`Expected integer ${min}..${max}`);
  return n;
}
function openBrowser(url) {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["rundll32", "url.dll,FileProtocolHandler", url]
        : ["xdg-open", url];
  const child = spawn(command[0], command.slice(1), {
    stdio: "ignore",
    detached: true,
    shell: false,
  });
  child.on("error", () =>
    console.error("Could not open browser; open the printed URL manually."),
  );
  child.unref();
}
export async function main(args = process.argv.slice(2)) {
  try {
    const { values: v, positionals } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        ...Object.fromEntries(
          stringOptions.map((k) => [k, { type: "string" }]),
        ),
        ...Object.fromEntries(
          booleanOptions.map((k) => [k, { type: "boolean" }]),
        ),
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
    if (v.help || !args.length) {
      console.log(HELP);
      return 0;
    }
    if (v.version) {
      console.log(
        JSON.parse(
          readFileSync(new URL("../package.json", import.meta.url), "utf8"),
        ).version,
      );
      return 0;
    }
    let [command, ...words] = positionals;
    if (command === "update") command = "index";
    if (!ALLOWED[command]) throw new Error("Unknown command; run chats --help");
    for (const key of Object.keys(v))
      if (!ALLOWED[command].includes(key))
        throw new Error(`--${key} is not valid for ${command}`);
    if (command !== "search" && words.length)
      throw new Error("Unexpected positional arguments");
    if (v.only && !HARNESSES.includes(v.only))
      throw new Error("Invalid source harness");
    let configuration, kind, name;
    if (command === "index") {
      if (
        Boolean(v["ai-summarize"]) !== Boolean(v.provider || v.harness) ||
        (v.provider && v.harness)
      )
        throw new Error(
          "--ai-summarize requires exactly one of --provider NAME or --harness NAME",
        );
      if (v["force-ai"] && !v["ai-summarize"])
        throw new Error("--force-ai requires --ai-summarize");
      if (v["ai-summarize"]) {
        configuration = JSON.parse(
          readFileSync(
            expandPath(
              v.config || join(homedir(), ".config/harness-chats/config.json"),
            ),
            "utf8",
          ),
        );
        kind = v.provider ? "provider" : "harness";
        name = v.provider || v.harness;
        const { backendConfig } = await import("./enrich.js");
        backendConfig(configuration, name, kind);
      }
    }
    if (command === "search" && v.harness && !HARNESSES.includes(v.harness))
      throw new Error("Invalid harness filter");
    const dbPath = v.db || DEFAULT_DB;
    if (command === "serve") {
      const port = integer(v.port, 8765, 0, 65535),
        { createServer } = await import("./web.js");
      const server = createServer(dbPath);
      server.listen(port, "127.0.0.1");
      try {
        await once(server, "listening");
      } catch (error) {
        server.emit("close");
        throw error;
      }
      const url = `http://127.0.0.1:${server.address().port}`;
      console.log(
        `Harness Chats: ${url}\nRefresh the index in another terminal: chats update`,
      );
      if (v.open) openBrowser(url);
      const stop = () => {
        server.close();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      await once(server, "close");
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      return 0;
    }
    const store = new Store(dbPath);
    try {
      if (command === "index") {
        const result = store.update(v.home || homedir(), v.only);
        output(result);
        if (v["ai-summarize"]) {
          console.error(
            "AI enabled: sending bounded user/assistant transcripts to the selected backend.",
          );
          const { enrich } = await import("./enrich.js"),
            ai = await enrich(store, configuration, name, kind, {
              force: v["force-ai"],
              harness: v.only,
            });
          output(ai);
          return ai.failed || result.errors.length ? 1 : 0;
        }
        return result.errors.length ? 1 : 0;
      }
      const result = store.search(words.join(" "), {
        harness: v.harness,
        repo: v.repo,
        limit: integer(v.limit, 50, 1, 200),
        offset: integer(v.offset, 0, 0, Number.MAX_SAFE_INTEGER),
      });
      if (v.json) output(result);
      else {
        console.log(`${result.total} conversations`);
        // Strip terminal escape sequences from untrusted imported content.
        const safe = (s) =>
          String(s)
            .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
            .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
        for (const c of result.items) {
          console.log(
            safe(
              `\n[${c.harness}] ${c.title}\n  ${c.summary}\n  ${c.repo || "Repository unknown"} | ${c.updated_at}\n  ID: ${c.id}`,
            ),
          );
          for (const b of c.branches)
            console.log(safe(`  Branch (${b.confidence}): ${b.name}`));
          for (const p of c.prs)
            console.log(safe(`  PR (mentioned): ${p.url}`));
        }
        if (result.total > result.items.length)
          console.log(
            "\nUse --limit/--offset, filters, or the browser to see more.",
          );
      }
      return 0;
    } finally {
      store.close();
    }
  } catch (error) {
    console.error(`chats: ${error.message}`);
    return 1;
  }
}
