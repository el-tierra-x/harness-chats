#!/usr/bin/env node
if (Number(process.versions.node.split(".")[0]) < 24) {
  console.error(
    "chats: Node.js 24+ is required (SQLite FTS5 support). Upgrade to Node 24 LTS.",
  );
  process.exitCode = 1;
} else {
  const { main } = await import("../src/cli.js");
  process.exitCode = await main();
}
