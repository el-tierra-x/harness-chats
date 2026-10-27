import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export const HARNESSES = ["codex", "cursor", "pi", "omp"];
export const hash = (text) => createHash("sha256").update(text).digest("hex");
export const canonical = (value) =>
  JSON.stringify(value, function (_key, v) {
    return v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v;
  });
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const decode = (value) =>
  JSON.parse(
    typeof value === "string" ? value : Buffer.from(value).toString("utf8"),
  );
function timestamp(value) {
  if (typeof value === "number")
    return new Date(value > 1e11 ? value : value * 1000).toISOString();
  return typeof value === "string" ? value : "";
}
function content(value) {
  if (typeof value === "string") return value;
  return Array.isArray(value)
    ? value
        .filter(
          (p) =>
            object(p) &&
            ["text", "input_text", "output_text"].includes(p.type) &&
            typeof p.text === "string",
        )
        .map((p) => p.text)
        .join("\n")
    : "";
}
function userText(text) {
  return text.replace(/<(\w[\w_-]*)\b[^>]*>[\s\S]*?<\/\1>/g, "").trim();
}
function localTitle(messages) {
  for (const m of messages) {
    if (m.role !== "user") continue;
    const line = userText(m.text)
      .split("\n")
      .map((l) => l.trim().replace(/^[# ]+/, ""))
      .find((l) => l && !/^(<|\[|You are |Current |superpowers:)/.test(l));
    if (line) return line.slice(0, 110);
  }
  return "Untitled conversation";
}
function branches(names, evidence) {
  if (typeof names === "string") names = [names];
  return Array.isArray(names)
    ? names
        .filter((n) => typeof n === "string" && n)
        .map((name) => ({ name, confidence: "recorded", evidence }))
    : [];
}
export function normalize(harness, nativeId, source, messages, options = {}) {
  const refs = [...(options.branches || [])],
    seen = new Set(refs.map((b) => b.name)),
    prs = new Map();
  for (const m of messages) {
    for (const [url] of m.text.matchAll(
      /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\b/g,
    ))
      prs.set(url, {
        url,
        confidence: "mentioned",
        evidence: "Conversation text",
      });
    for (const [, name] of m.text.matchAll(
      /\bgit\s+(?:checkout\s+(?:-b\s+|-B\s+)?|switch\s+(?:-c\s+|-C\s+)?)([\w][\w./-]*)/g,
    )) {
      if (!seen.has(name)) {
        refs.push({
          name,
          confidence: "mentioned",
          evidence: "git checkout/switch in conversation",
        });
        seen.add(name);
      }
    }
  }
  const title = options.title || localTitle(messages);
  const user = messages.find(
    (m) => m.role === "user" && localTitle([m]) !== "Untitled conversation",
  );
  const assistant = messages.findLast((m) => m.role === "assistant");
  const excerpt = (text, max) => text.replace(/\s+/g, " ").trim().slice(0, max);
  const summary =
    [
      excerpt(userText(user?.text || ""), 240),
      excerpt(assistant?.text || "", 280),
    ]
      .filter(Boolean)
      .join(" ") || title;
  const chat = {
    id: hash(`${harness}:${nativeId}`).slice(0, 32),
    source_id: String(nativeId),
    harness,
    source: String(source),
    title,
    summary,
    cwd: options.cwd || "",
    repo: options.repo || options.cwd || "",
    created_at: timestamp(options.created),
    updated_at: timestamp(options.updated || options.created),
    messages,
    branches: refs,
    prs: [...prs.values()],
    warnings: options.warnings || 0,
  };
  const { source: _source, warnings: _warnings, ...stable } = chat;
  chat.content_hash = hash(canonical(stable));
  return chat;
}
export function readJsonl(path, harness) {
  let meta,
    title = "",
    repo = "",
    refs = [],
    warnings = 0,
    updated = "",
    created = "";
  const messages = [],
    events = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
      if (!object(row)) throw new Error();
    } catch {
      warnings++;
      continue;
    }
    updated = row.timestamp || updated;
    const payload = object(row.payload) ? row.payload : {};
    if (["session", "session_meta"].includes(row.type)) {
      meta = row.type === "session_meta" ? payload : row;
      created = meta.timestamp || row.timestamp || "";
      if (object(meta.git)) {
        refs = branches(meta.git.branch, "Session git metadata");
        repo = meta.git.repository_url || "";
      }
    }
    if (row.type === "title" && typeof row.title === "string")
      title = row.title;
    if (row.type === "session_info" && typeof row.name === "string")
      title = row.name;
    const msg =
      row.type === "message"
        ? row.message
        : row.type === "response_item"
          ? payload
          : null;
    if (object(msg)) {
      let role = msg.role === "toolResult" ? "tool" : msg.role,
        text = content(msg.content);
      if (
        ["function_call_output", "custom_tool_call_output"].includes(msg.type)
      ) {
        role = "tool";
        text = content(msg.output);
      }
      if (["user", "assistant", "tool"].includes(role) && text)
        messages.push({
          role,
          text,
          timestamp: timestamp(row.timestamp || msg.timestamp),
        });
    }
    if (
      row.type === "event_msg" &&
      ["user_message", "agent_message"].includes(payload.type) &&
      typeof payload.message === "string" &&
      payload.message
    )
      events.push({
        role: payload.type === "user_message" ? "user" : "assistant",
        text: payload.message,
        timestamp: timestamp(row.timestamp),
      });
  }
  if (!meta || !Object.keys(meta).length) throw new Error("No session header");
  return normalize(
    harness,
    meta.id || meta.session_id || resolve(path),
    path,
    messages.some((m) => m.role === "user")
      ? messages
      : [...events, ...messages],
    { title, cwd: meta.cwd, repo, created, updated, branches: refs, warnings },
  );
}

export function* readCursor(path, onWarning = () => {}) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000;BEGIN");
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name),
    );
    const headers = new Map();
    if (tables.has("composerHeaders"))
      for (const r of db
        .prepare("SELECT composerId,value FROM composerHeaders")
        .all()) {
        try {
          headers.set(r.composerId, decode(r.value));
        } catch {
          onWarning();
        }
      }
    if (tables.has("cursorDiskKV")) {
      const bubbleQuery = db.prepare(
        "SELECT value FROM cursorDiskKV WHERE key=?",
      );
      for (const r of db
        .prepare(
          "SELECT key,value FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;' ORDER BY key",
        )
        .all()) {
        try {
          const data = decode(r.value),
            sid = data.composerId || r.key.slice(13),
            combined = {
              ...data,
              ...headers.get(data.composerId || r.key.slice(13)),
            };
          const messages = [];
          for (const header of (data.fullConversationHeadersOnly?.length
            ? data.fullConversationHeadersOnly
            : data.conversation) || []) {
            if (!object(header)) continue;
            const found = bubbleQuery.get(`bubbleId:${sid}:${header.bubbleId}`),
              msg = found ? decode(found.value) : header;
            if (
              typeof msg.text === "string" &&
              msg.text &&
              [1, 2].includes(msg.type)
            )
              messages.push({
                role: msg.type === 1 ? "user" : "assistant",
                text: msg.text,
                timestamp: timestamp(msg.createdAt),
              });
          }
          const repos = Array.isArray(combined.trackedGitRepos)
              ? combined.trackedGitRepos
              : [],
            repo = repos[0] || {};
          const uri = combined.workspaceIdentifier?.uri;
          const cwd =
            repo.repoPath ||
            (typeof uri === "string" && uri.startsWith("file:")
              ? fileURLToPath(uri)
              : "");
          yield normalize("cursor", sid, path, messages, {
            title: combined.name,
            cwd,
            created: combined.createdAt,
            updated: combined.lastUpdatedAt,
            branches: repos.flatMap((r) =>
              branches(r?.branches, "Cursor tracked repository metadata"),
            ),
          });
        } catch {
          onWarning();
        }
      }
    }
    if (tables.has("ItemTable"))
      for (const r of db
        .prepare(
          "SELECT key,value FROM ItemTable WHERE key IN ('composer.composerData','workbench.panel.aichat.view.aichat.chatdata')",
        )
        .all()) {
        try {
          const data = decode(r.value),
            items =
              r.key === "composer.composerData" ? data.allComposers : data.tabs;
          for (const item of items || []) {
            const sid = item.composerId || item.id;
            if (!sid) continue;
            const messages = (
              item.conversation?.length ? item.conversation : item.bubbles || []
            )
              .filter((m) => typeof m.text === "string" && m.text)
              .map((m) => ({
                role: [1, "user"].includes(m.type) ? "user" : "assistant",
                text: m.text,
                timestamp: "",
              }));
            if (messages.length)
              yield normalize("cursor", sid, path, messages, {
                title: item.name,
                created: item.createdAt,
                updated: item.lastUpdatedAt,
              });
          }
        } catch {
          onWarning();
        }
      }
  } finally {
    db.close();
  }
}
function* walk(path) {
  if (!existsSync(path)) return;
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.isDirectory()) yield* walk(join(path, entry.name));
    else if (entry.isFile()) yield join(path, entry.name);
  }
}
export function* discover(home) {
  const roots = [
    ["codex", ".codex/sessions"],
    ["codex", ".codex/archived_sessions"],
    ["pi", ".pi/agent/sessions"],
    ["omp", ".omp/agent/sessions"],
  ];
  const profiles = join(home, ".omp/profiles");
  if (existsSync(profiles))
    for (const e of readdirSync(profiles, { withFileTypes: true }))
      if (e.isDirectory())
        roots.push(["omp", `.omp/profiles/${e.name}/agent/sessions`]);
  for (const [harness, root] of roots)
    for (const path of walk(join(home, root)))
      if (path.endsWith(".jsonl")) yield { harness, path };
  for (const root of [
    "Library/Application Support/Cursor/User",
    ".config/Cursor/User",
    "AppData/Roaming/Cursor/User",
  ]) {
    const global = join(home, root, "globalStorage/state.vscdb");
    if (existsSync(global)) yield { harness: "cursor", path: global };
    const workspace = join(home, root, "workspaceStorage");
    if (existsSync(workspace))
      for (const e of readdirSync(workspace, { withFileTypes: true })) {
        const path = join(workspace, e.name, "state.vscdb");
        if (e.isDirectory() && existsSync(path))
          yield { harness: "cursor", path };
      }
  }
}
