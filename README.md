# Harness Chats

**Find a coding conversation without remembering which harness you used.**

A local-first **Node.js CLI + browser app** for indexing and searching chat histories from **Codex, Cursor, pi, and omp**. SQLite full-text search, descriptive local titles/summaries, harness grouping, repository filters, transcripts, and historical branch/PR references.

**No Python. No runtime dependencies. No model calls unless you explicitly opt in.**

## Requirements

- **Node.js 24 LTS or newer**, with built-in `node:sqlite` and FTS5. The minimum tested version is 24.0.0; early Node 24 versions may print an experimental SQLite warning. Node 22 is not supported.
- npm (included with Node).
- Existing local history from at least one supported harness.

## Install from GitHub

```sh
npm install --global git+https://github.com/el-tierra-x/harness-chats.git
chats --help
chats index
chats serve --open
```

This repository is not published to the npm registry. `package.json` is marked `private` to prevent accidental publication; installing from GitHub or a local checkout still works.

### Or run from a checkout

```sh
git clone https://github.com/el-tierra-x/harness-chats.git
cd harness-chats
npm ci
npm run index
npm run serve -- --open
```

Open **http://127.0.0.1:8765**. Keep the server running while using the app. To install the checkout's CLI globally, run `npm install --global .`; the `chats` and `harness-chats` binaries are equivalent.

## Commands

| Command                       | What it does                                         |
| ----------------------------- | ---------------------------------------------------- |
| `chats index`                 | Discover histories and build/update the SQLite index |
| `chats update`                | Incremental alias for `index`                        |
| `chats search "feature name"` | Search across indexed conversations                  |
| `chats serve`                 | Run the read-only local browser app                  |
| `chats --help`                | Show commands and flags                              |
| `chats --version`             | Show package version                                 |

```sh
# Index everything, or just one harness
chats index
chats update --only pi

# Search transcript text, local/AI summaries, repositories, branches, and PR URLs
chats search "calendar export"
chats search "dashboard" --harness codex
chats search "feat/export" --json
chats search "https://github.com/example/project/pull/42"
chats search "" --repo /absolute/path/to/project --limit 20 --offset 20

# Choose history home, index path, or browser port
chats index --home /another/home
chats index --db /path/to/custom.sqlite
chats search "auth" --db /path/to/custom.sqlite
chats serve --db /path/to/custom.sqlite --port 8766 --open
```

Options can appear before or after the command. Search terms are **literal AND words**, not raw FTS expressions; punctuation in URLs and branch names is tokenized. Search defaults to 50 results, up to 200 with `--limit`; use `--offset` for more.

### npm scripts

Pass arguments after `--`:

```sh
npm run index
npm run update -- --only cursor
npm run search -- "authentication" --harness pi --json
npm run serve -- --port 8766 --open
npm start
```

After another coding session, run **`chats update`**, then click **Refresh index view** in the browser. There is no background watcher or write-capable HTTP endpoint.

## Browser app

- Search all four harnesses in one place.
- Group conversations by harness, or show a combined list.
- Filter by harness and repository.
- See title, summary, timestamps, branch/PR references, and message count.
- Open a conversation's transcript and original source location.
- Use **Load more** for paginated results.

Titles prefer native session titles; otherwise they are extracted from the first meaningful user message. Default summaries are deterministic excerpts from the request and final assistant response, not semantic AI summaries.

## Optional AI titles and summaries

**Normal `index`, `update`, `search`, and `serve` do not send history to a model.** AI requires `--ai-summarize` plus an explicit backend. Sensitive code and conversation text may be sent to that backend: check your organization's policies first.

Copy the example and edit your endpoint/model:

```sh
mkdir -p ~/.config/harness-chats
cp examples/config.example.json ~/.config/harness-chats/config.json
```

If installed globally, create that JSON file yourself using this minimal example:

```json
{
  "providers": {
    "my-provider": {
      "type": "openai",
      "url": "https://api.openai.com/v1/chat/completions",
      "model": "YOUR_MODEL",
      "api_key_env": "OPENAI_API_KEY",
      "timeout": 90
    },
    "local-model": {
      "type": "openai",
      "url": "http://127.0.0.1:1234/v1/chat/completions",
      "model": "YOUR_LOCAL_MODEL"
    }
  },
  "harnesses": {
    "pi": {
      "command": ["/absolute/path/to/your-tools-disabled-summary-wrapper"],
      "timeout": 120
    }
  }
}
```

```sh
# Provider reads credentials from the named environment variable
export OPENAI_API_KEY="your-key"
chats update --ai-summarize --provider my-provider

# An OpenAI-compatible local server
chats update --ai-summarize --provider local-model --only codex

# Reuse a configured non-interactive harness command
chats update --ai-summarize --harness pi

# Force regeneration, or select another configuration
chats update --ai-summarize --provider my-provider --force-ai
chats update --ai-summarize --provider my-provider --config /path/to/config.json
```

OpenAI-compatible chat-completions and Anthropic messages APIs are supported. For Anthropic, set `"type":"anthropic"`, the full `https://api.anthropic.com/v1/messages` endpoint, your model, and `"api_key_env":"ANTHROPIC_API_KEY"`. HTTPS is required except for loopback servers; redirects are rejected. Credentials are not stored in the index.

### Harness command contract

A harness backend is a **trusted argv array**, not a shell command. It receives the prompt on stdin and must print only:

```json
{
  "title": "Short feature title",
  "summary": "What was discussed, decided, and completed."
}
```

A fenced JSON response is also accepted. Your wrapper must select its provider/model, suppress progress logs on stdout, and run the chosen harness **non-interactively with coding tools disabled and session/file writes disabled**. Use an absolute executable/wrapper path. No unrestricted agent command is supplied by default.

Commands run without a shell in an empty temporary directory, with a timeout and output limit. **That directory is not an OS sandbox**: command configuration—not this app—must prevent tool/filesystem/network access. Do not configure an unrestricted coding agent.

Only user/assistant text enters AI prompts, capped at 24,000 characters using beginning + end. Tool outputs and reasoning blocks are excluded. AI results are cached by content hash, backend configuration, and prompt version. Source changes invalidate enrichment. Failures preserve the current local/previous summary and return a nonzero status. Errors do not echo provider responses or command stderr.

An AI run can process **all indexed conversations**, including archived ones. Use `--only` to scope by harness. There is no billing cap or cost estimate.

## Sources and branch/PR accuracy

| Harness          | Default history locations relative to your home                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| Codex            | `.codex/sessions/**/*.jsonl`, `.codex/archived_sessions/**/*.jsonl`                                      |
| pi               | `.pi/agent/sessions/**/*.jsonl`                                                                          |
| omp              | `.omp/agent/sessions/**/*.jsonl`, `.omp/profiles/*/agent/sessions/**/*.jsonl`                            |
| Cursor (macOS)   | `Library/Application Support/Cursor/User/globalStorage/state.vscdb` and `workspaceStorage/*/state.vscdb` |
| Cursor (Linux)   | `.config/Cursor/User/` with the same storage layout                                                      |
| Cursor (Windows) | `AppData/Roaming/Cursor/User/` with the same storage layout                                              |

Cursor conversations are assembled from `composerData:`, ordered `bubbleId:` records, and `composerHeaders`. Basic legacy ItemTable conversations are supported. Some Cursor caches contain headers but no local transcript.

- **Recorded branch:** structured session/repository metadata. Not proof that every message used that branch.
- **Mentioned branch:** a `git checkout`/`git switch` command in conversation text; it may have been proposed rather than executed.
- **Mentioned PR:** an explicit GitHub `/owner/repo/pull/NUMBER` URL. Not proof the chat created it.
- **Repository:** recorded git URL, cwd, or workspace path. Unknown when absent.

There is **no current-HEAD inference, GitHub API enrichment, or PR-status claim**. GitLab/Bitbucket links and bare `#123` references are not resolved. Missing metadata remains unknown.

## Storage, privacy, and migration

The default plaintext index is **`~/.local/share/harness-chats/index.sqlite`**. It is separate from the source checkout and npm package, created with file mode `0600` in a private app directory on systems supporting POSIX permissions. On Windows, rely on your account's filesystem ACLs.

The index contains **copies of transcript text and tool output**; it is not encrypted or automatically secret-redacted. Protect backups and local filesystem access. Reasoning-only blocks and source system/developer messages are not indexed as messages.

- Source files/databases are read-only. Cursor uses a consistent SQLite read transaction, including WAL data.
- Unchanged JSONL files are skipped; Cursor records are checked by content hash. Partial lines are tolerated; corrupt records report warnings, and truncated malformed files do not erase richer indexed transcripts.
- Chat identity includes the harness. Equal IDs in different harnesses remain distinct.
- Deleting a source does **not** delete its indexed copy. This is an archive, not an automatically pruning mirror.
- To remove the index, stop the server and delete the index file, then re-import if desired. This never deletes original harness histories.
- The native Node version retains the earlier local prototype's SQLite schema and default path. No migration command is required. Its first update may reparse files and refresh content hashes; it does not delete chats or source history.

The browser binds **only `127.0.0.1`**, rejects foreign Host/Origin and cross-site requests, blocks framing, serves fixed assets, and renders transcripts as text instead of HTML. There is no CORS support or HTTP command-execution endpoint. Do not proxy it onto a network; **localhost is not authentication**, and other local users/processes may access it.

## Development and verification

```sh
npm ci
npm test
npm run check
npm pack --dry-run
```

Tests use temporary synthetic histories, SQLite databases, fake provider responses, a local summarizer subprocess, and a loopback HTTP server. They do not read your real chats or contact AI providers.

Optional browser test (Node 24+ and installed Chrome):

```sh
npm run test:browser
# If Chrome isn't at the standard macOS location:
CHROME_PATH=/path/to/chrome npm run test:browser
```

It exercises synthetic conversations, search, harness filtering, transcript escaping, and PR links. CI is configured for Node 24.0.0 and latest Node 24 on Linux, macOS, and Windows. See [architecture](docs/architecture.md) for module boundaries.

## Limitations and troubleshooting

- **`node:sqlite` unavailable:** upgrade to Node 24 LTS; no Python fallback is bundled.
- **No results:** run `chats index`, check `--home` and harness filters. Custom CODEX/PI/omp home directories are not auto-discovered; `--home` assumes the standard relative layout.
- **Port in use:** use `chats serve --port 8766`.
- **Source/index busy:** retry after the writing app finishes. SQLite contention can cause a retryable error.
- **Source schema changes:** future harness versions may require importer updates.
- pi/omp histories are shown in append order; not every conversation-tree fork is reconstructed. Distinct session IDs remain separate; chats are not merged across harnesses.
- This is full-text search, not embedding/semantic search. Default summaries are extracts.
- No cloud sync, daemon, npm-registry publication, or automatic PR lookups.

## License

[MIT](LICENSE)
