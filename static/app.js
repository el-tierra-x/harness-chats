"use strict";
const $ = (id) => document.getElementById(id);
let items = [],
  total = 0,
  generation = 0,
  detailGeneration = 0,
  active = "";
function node(tag, text, cls) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (cls) el.className = cls;
  return el;
}
function date(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "Date unknown"
    : parsed.toLocaleString();
}
async function api(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok)
    throw new Error((await res.json()).error || "Unable to read index");
  return res.json();
}
function render() {
  const root = $("results");
  root.replaceChildren();
  const groups = $("group").checked
    ? [...new Set(items.map((c) => c.harness))].sort()
    : ["All conversations"];
  for (const name of groups) {
    const chats = $("group").checked
      ? items.filter((c) => c.harness === name)
      : items;
    root.append(node("h2", `${name} · ${chats.length}`, "group-title"));
    for (const chat of chats) {
      const card = node(
        "button",
        undefined,
        "card" + (active === chat.id ? " selected" : ""),
      );
      card.type = "button";
      card.append(
        node("span", chat.harness.toUpperCase(), "badge"),
        node("span", date(chat.updated_at), "time"),
        node("h3", chat.title),
        node("p", chat.summary, "preview"),
        node("div", chat.repo || "Repository unknown", "repo"),
      );
      const refs = [
        ...chat.branches.map((b) => `${b.name} (${b.confidence})`),
        ...chat.prs.map((p) => `PR #${p.url.split("/").pop()} (mentioned)`),
      ];
      if (refs.length) card.append(node("div", refs.join(" · "), "refs"));
      card.addEventListener("click", () => showChat(chat.id));
      root.append(card);
    }
  }
  if (!items.length)
    root.append(
      node(
        "p",
        "No conversations found. Try fewer words, change filters, or run chats update.",
        "empty-list",
      ),
    );
  $("more").hidden = items.length >= total;
}
async function search(append = false) {
  const token = ++generation;
  $("status").textContent = "Searching…";
  $("more").disabled = true;
  const params = new URLSearchParams({
    q: $("query").value,
    harness: $("harness").value,
    repo: $("repo").value,
    limit: "50",
    offset: append ? String(items.length) : "0",
  });
  try {
    const result = await api("/api/chats?" + params);
    if (generation !== token) return;
    items = append ? [...items, ...result.items] : result.items;
    total = result.total;
    const selectedRepo = $("repo").value;
    $("repo").replaceChildren(
      new Option("All repositories", ""),
      ...result.repos
        .filter((r) => r.name)
        .map((r) => new Option(`${r.name} (${r.count})`, r.name)),
    );
    $("repo").value = selectedRepo;
    $("status").textContent =
      `${total.toLocaleString()} conversations · showing ${items.length}`;
    render();
  } catch (err) {
    if (generation === token) $("status").textContent = err.message;
  } finally {
    if (generation === token) $("more").disabled = false;
  }
}
async function showChat(id) {
  const token = ++detailGeneration;
  active = id;
  render();
  const pane = $("detail");
  pane.replaceChildren(node("p", "Loading conversation…"));
  try {
    const chat = await api("/api/chat?" + new URLSearchParams({ id }));
    if (detailGeneration !== token) return;
    const top = node("div", undefined, "detail-head");
    top.append(
      node(
        "span",
        `${chat.harness.toUpperCase()} · ${date(chat.updated_at)}`,
        "eyebrow",
      ),
      node("h2", chat.title),
      node("p", chat.summary),
      node(
        "p",
        `${chat.summary_kind === "ai" ? "AI summary" : "Local extract"} · ${chat.messages.length} messages`,
        "muted",
      ),
      node("p", chat.repo || "Repository unknown", "repo"),
    );
    for (const branch of chat.branches) {
      const ref = node(
        "p",
        `Branch (${branch.confidence}): ${branch.name}`,
        "refs",
      );
      ref.title = branch.evidence;
      top.append(ref);
    }
    for (const pr of chat.prs) {
      const line = node("p", "Mentioned PR: ", "refs");
      if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(pr.url)) {
        const a = node("a", pr.url);
        a.href = pr.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        line.append(a);
      }
      top.append(line);
    }
    const details = node("details");
    details.append(
      node("summary", "Source & identity"),
      node("pre", `${chat.source}\n${chat.source_id}\n${chat.cwd}`),
    );
    top.append(details);
    pane.replaceChildren(top);
    for (const msg of chat.messages) {
      const block = node("article", undefined, `message ${msg.role}`);
      block.append(
        node(
          "h3",
          `${msg.role}${msg.timestamp ? " · " + date(msg.timestamp) : ""}`,
        ),
        node("pre", msg.text),
      );
      pane.append(block);
    }
    if (!chat.messages.length)
      pane.append(node("p", "No transcript text available in this source."));
  } catch (err) {
    if (detailGeneration === token)
      pane.replaceChildren(node("p", err.message));
  }
}
$("search").addEventListener("submit", (e) => {
  e.preventDefault();
  search();
});
$("harness").addEventListener("change", () => search());
$("repo").addEventListener("change", () => search());
$("group").addEventListener("change", render);
$("refresh").addEventListener("click", () => search());
$("more").addEventListener("click", () => search(true));
search();
