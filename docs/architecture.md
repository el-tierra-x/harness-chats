# Architecture

Harness Chats is a native Node.js (24+) ESM package. It uses only built-in modules: node:sqlite for the incremental SQLite/FTS5 index, node:http for the read-only loopback UI, and node:test for tests. No Python runtime, native addon installation, frontend build, or runtime dependency is required.

## Commands

`chats index` discovers and imports source history. `chats update` is its incremental alias. `chats search` queries the index. `chats serve` runs the browser UI. npm scripts expose the same commands. The bin works after `npm install -g .` or installing from the GitHub repository; nothing is published to the npm registry by this project setup.

## Data flow

Read-only Codex, pi, omp JSONL and Cursor SQLite importers normalize sessions. A stable harness + native ID identifies each chat. File timestamps avoid unnecessary JSONL parsing; content hashes avoid unchanged writes. Cursor is read in a read-only SQLite transaction including WAL data. SQLite stores normalized chat JSON and full-text tokens; unchanged AI enrichment is cached. Truncated/malformed sources must not overwrite richer existing transcripts.

The existing local SQLite schema and default path are retained. Ported hashing may cause one refresh of parsed records; no chat/source data is deleted. Local development histories/indexes, credentials, and internal work logs are excluded from git and npm packages.

## Privacy boundaries

Import/search/serve make no model calls. AI summaries require explicit opt-in and a named backend. Provider requests reject redirects, enforce HTTPS except loopback, and read keys from environment variables. Harness commands use a trusted argv array without a shell; users must disable coding tools in the selected command. A temporary working directory is not an OS sandbox.

The server binds only 127.0.0.1, validates Host/Origin, blocks cross-site requests and framing, serves only fixed assets, and has no mutating endpoints. Transcripts are plain text in the UI and index. Historical branches come from recorded metadata or labeled mentions, never current repository HEAD. PR URLs are explicit mentions, not ownership/status claims.

## Alternatives considered

An npm wrapper around the existing Python engine would have been smaller, but would retain the Python installation requirement. The user chose native Node.js. A bundled SQLite dependency was unnecessary because supported Node versions include SQLite with FTS5. TypeScript would add a build step without benefiting this small CLI enough to justify it; JavaScript ESM with executable tests is used instead.

## Verification

Synthetic fixtures cover all importers, idempotent updates, corruption, search invalidation, CLI validation, AI caching/protocols, loopback security, and package execution. An optional headless Chrome smoke test covers the browser. CI tests the minimum Node 24.0.0 and latest Node 24 LTS on Linux, macOS, and Windows. Node 22.13 was rejected after runtime testing showed its SQLite build lacks FTS5. No real conversations or external provider calls are needed for automated tests.
