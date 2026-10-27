import { mkdirSync, openSync, closeSync, chmodSync, statSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { discover, readJsonl, readCursor } from "./importers.js";

export const DEFAULT_DB = join(
  homedir(),
  ".local/share/harness-chats/index.sqlite",
);
export const expandPath = (p) =>
  resolve(
    p === "~"
      ? homedir()
      : p.startsWith("~/")
        ? join(homedir(), p.slice(2))
        : p,
  );
export class Store {
  constructor(path = DEFAULT_DB) {
    this.path = expandPath(path);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    closeSync(openSync(this.path, "a", 0o600));
    chmodSync(this.path, 0o600);
    this.db = new DatabaseSync(this.path);
    this.db.exec(`PRAGMA busy_timeout=30000;
      CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY,harness TEXT NOT NULL,source_id TEXT,title TEXT,summary TEXT,repo TEXT,updated_at TEXT,content_hash TEXT,data TEXT NOT NULL,ai TEXT,ai_key TEXT);
      CREATE VIRTUAL TABLE IF NOT EXISTS chat_search USING fts5(id UNINDEXED,body);
      CREATE TABLE IF NOT EXISTS sources(path TEXT PRIMARY KEY,stamp TEXT);`);
  }
  close() {
    this.db.close();
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  upsert(chat) {
    const old = this.db
      .prepare(
        "SELECT content_hash,json_array_length(data,'$.messages') AS n FROM chats WHERE id=?",
      )
      .get(chat.id);
    if (
      old &&
      (old.content_hash === chat.content_hash ||
        (chat.warnings && chat.messages.length < old.n))
    )
      return false;
    this.db
      .prepare(
        `INSERT INTO chats(id,harness,source_id,title,summary,repo,updated_at,content_hash,data) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,summary=excluded.summary,repo=excluded.repo,updated_at=excluded.updated_at,content_hash=excluded.content_hash,data=excluded.data,ai=NULL,ai_key=NULL`,
      )
      .run(
        chat.id,
        chat.harness,
        chat.source_id,
        chat.title,
        chat.summary,
        chat.repo,
        chat.updated_at,
        chat.content_hash,
        JSON.stringify(chat),
      );
    this.reindex(chat.id);
    return true;
  }
  get(id) {
    const row = this.db.prepare("SELECT data,ai FROM chats WHERE id=?").get(id);
    if (!row) return null;
    return {
      ...JSON.parse(row.data),
      ...(row.ai ? JSON.parse(row.ai) : {}),
      summary_kind: row.ai ? "ai" : "local",
    };
  }
  reindex(id) {
    const c = this.get(id),
      body = [
        c.title,
        c.summary,
        c.repo,
        c.cwd,
        ...c.messages.map((m) => m.text),
        ...c.branches.map((b) => b.name),
        ...c.prs.map((p) => p.url),
      ].join("\n");
    this.db.prepare("DELETE FROM chat_search WHERE id=?").run(id);
    this.db
      .prepare("INSERT INTO chat_search(id,body) VALUES (?,?)")
      .run(id, body);
  }
  update(home = homedir(), harness) {
    const stats = {
        updated: 0,
        unchanged: 0,
        warnings: 0,
        sources: 0,
        errors: [],
      },
      cursorSeen = new Set();
    for (const source of discover(expandPath(home))) {
      const { path, harness: name } = source;
      if (harness && name !== harness) continue;
      stats.sources++;
      try {
        const st = statSync(path, { bigint: true }),
          stamp = `node-v1:${st.mtimeNs}:${st.size}`;
        const old = this.db
          .prepare("SELECT stamp FROM sources WHERE path=?")
          .get(path);
        if (name !== "cursor" && old?.stamp === stamp) {
          stats.unchanged++;
          continue;
        }
        const delta = { updated: 0, unchanged: 0, warnings: 0 },
          seen = [];
        this.transaction(() => {
          const chats =
            name === "cursor"
              ? readCursor(path, () => delta.warnings++)
              : [readJsonl(path, name)];
          for (const chat of chats) {
            if (name === "cursor") {
              if (cursorSeen.has(chat.id) || seen.includes(chat.id)) continue;
              seen.push(chat.id);
            }
            delta.warnings += chat.warnings;
            if (this.upsert(chat)) delta.updated++;
            else delta.unchanged++;
          }
          // Retry malformed JSONL on the next update instead of permanently caching a partial read.
          if (!delta.warnings)
            this.db
              .prepare(
                "INSERT OR REPLACE INTO sources(path,stamp) VALUES (?,?)",
              )
              .run(path, stamp);
        });
        for (const id of seen) cursorSeen.add(id);
        for (const key of Object.keys(delta)) stats[key] += delta[key];
      } catch (error) {
        stats.warnings++;
        stats.errors.push(
          `${name}: ${basename(path)}: ${error.code || error.name}`,
        );
      }
    }
    return stats;
  }
  facets(field) {
    if (!["harness", "repo"].includes(field)) throw new Error("Invalid facet");
    return this.db
      .prepare(
        `SELECT ${field} AS name,count(*) AS count FROM chats GROUP BY ${field} ORDER BY ${field}`,
      )
      .all()
      .map((r) => ({ ...r }));
  }
  search(query = "", { harness = "", repo = "", limit = 50, offset = 0 } = {}) {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      !Number.isInteger(offset) ||
      offset < 0
    )
      throw new RangeError(
        "limit must be 1..200 and offset must be nonnegative",
      );
    const facets = {
        harnesses: this.facets("harness"),
        repos: this.facets("repo"),
      },
      terms = query.match(/[\p{L}\p{N}]+/gu) || [],
      clauses = [],
      params = [];
    if (query.trim() && !terms.length)
      return { items: [], total: 0, ...facets };
    if (terms.length) {
      clauses.push(
        "id IN (SELECT id FROM chat_search WHERE chat_search MATCH ?)",
      );
      params.push(
        terms
          .slice(0, 40)
          .map((t) => `"${t}"`)
          .join(" AND "),
      );
    }
    for (const [field, value] of [
      ["harness", harness],
      ["repo", repo],
    ])
      if (value) {
        clauses.push(`${field}=?`);
        params.push(value);
      }
    const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
    const total = this.db
      .prepare("SELECT count(*) AS n FROM chats" + where)
      .get(...params).n;
    // Keep potentially huge transcript arrays out of list responses and JS memory.
    const rows = this.db
      .prepare(
        "SELECT json_remove(data,'$.messages') AS data,json_array_length(data,'$.messages') AS n,ai FROM chats" +
          where +
          " ORDER BY updated_at DESC,id LIMIT ? OFFSET ?",
      )
      .all(...params, limit, offset);
    const items = rows.map((r) => ({
      ...JSON.parse(r.data),
      ...(r.ai ? JSON.parse(r.ai) : {}),
      summary_kind: r.ai ? "ai" : "local",
      message_count: r.n,
    }));
    return { items, total, ...facets };
  }
}
