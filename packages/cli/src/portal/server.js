// M9 web portal — `lattice dev` is the single local portal home.
//
// One Vite dev server serves:
//   GET  /                                   → the portal home: deck list,
//                                              per-deck status summary
//                                              (validate / lint / lock /
//                                              provenance), and the four
//                                              entries (viewer, present,
//                                              video workbench deep link,
//                                              review)
//   GET  /lattice/portal/decks               → the same status as JSON
//   GET  /lattice/portal/deck/<id>/review    → read-only review view: the
//                                              deck's provenance history and
//                                              its latest lint report
//   GET  /workbench and /workbench/<deck-id> → the M7 video workbench as a
//                                              deck-scoped route of this
//                                              portal (issue 005): no second
//                                              port, no lazy start; the
//                                              handler is loaded dynamically
//                                              on first hit (A35 load
//                                              boundary)
//
// Module-graph isolation (A35, restated by issue 005) is a load boundary:
// the portal never *statically* imports video backend code — the workbench
// route handler is dynamically imported when a /workbench request arrives,
// and dev, present, and export stay statically unreachable from any video
// backend.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { listDeckIds, lockPathFor, readManifest, readLockRecord } from "../edit/deck-view.js";

const LINT_REPORT_PATH_SEGMENTS = [".lattice", "inspections", "latest.json"];
const PROVENANCE_DIR_SEGMENTS = [".lattice", "provenance"];

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);

function rel(cwd, target) {
  return path.relative(cwd, target).split(path.sep).join("/");
}

function provenanceDir(cwd) {
  return path.resolve(cwd, ...PROVENANCE_DIR_SEGMENTS);
}

function lintReportPath(cwd) {
  return path.resolve(cwd, ...LINT_REPORT_PATH_SEGMENTS);
}

function readProvenanceRecords(cwd, deckId, { limit = 20 } = {}) {
  const dir = provenanceDir(cwd);
  if (!fs.existsSync(dir)) return { total: 0, records: [] };
  const records = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8"));
      if (record.deck === deckId) records.push(record);
    } catch {
      // Unreadable records are skipped: the review view is a convenience
      // surface, never a validation authority.
    }
  }
  records.sort((a, b) => String(b.when ?? "").localeCompare(String(a.when ?? "")));
  return { total: records.length, records: records.slice(0, limit) };
}

function readLintReport(cwd) {
  const reportPath = lintReportPath(cwd);
  if (!fs.existsSync(reportPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch {
    return null;
  }
}

function deckStatusSummary({ cwd, deckId, deckDir, validate, lint }) {
  let lock = null;
  let manifest = null;
  try {
    manifest = readManifest(deckDir);
  } catch {
    manifest = null;
  }
  try {
    const lockRecord = readLockRecord(path.resolve(cwd, ".lattice", "content-locks"), deckId);
    lock = lockRecord
      ? { locked: true, schema: lockRecord.schema ?? null, compositeHash: lockRecord.fingerprint?.compositeHash?.slice(0, 12) ?? null, path: rel(cwd, lockPathFor(path.resolve(cwd, ".lattice", "content-locks"), deckId)) }
      : { locked: false };
  } catch {
    lock = { locked: false, error: "unreadable" };
  }
  const provenance = readProvenanceRecords(cwd, deckId, { limit: 1 });
  return {
    id: deckId,
    title: manifest?.title ?? deckId,
    presenter: manifest?.presenter ?? null,
    theme: manifest?.theme ?? null,
    slides: Array.isArray(manifest?.routes?.main) ? manifest.routes.main.length : null,
    hasTimeline: manifest?.timeline !== undefined,
    validate,
    lint,
    lock,
    provenance: {
      total: provenance.total,
      latest: provenance.records[0]
        ? { when: provenance.records[0].when, actor: provenance.records[0].actor, field: provenance.records[0].field, command: provenance.records[0].command }
        : null,
    },
    entries: {
      viewer: `/?deck=${encodeURIComponent(deckId)}`,
      present: `/?deck=${encodeURIComponent(deckId)}&present=1`,
      // Issue 005: the fourth entry is the deck's own video workbench view,
      // served by this portal as a plain deep link — no POST, no lazy start,
      // no second port.
      workbench: `/workbench/${encodeURIComponent(deckId)}`,
      review: `/lattice/portal/deck/${encodeURIComponent(deckId)}/review`,
    },
  };
}

/**
 * Collect the portal status for every deck. `runValidate` (injected in
 * tests) defaults to one real `lattice validate` subprocess per call; the
 * dev server caches the result until the decks tree changes.
 */
export async function collectPortalStatus({ cwd, config, runValidate }) {
  const decksDir = path.resolve(cwd, config.decksDir);
  const deckIds = listDeckIds(decksDir);
  const validateReport = runValidate
    ? await runValidate({ cwd, deckIds })
    : await defaultRunValidate({ cwd, deckIds });
  const lintReport = readLintReport(cwd);
  const lintSummary = lintReport
    ? {
        source: rel(cwd, lintReportPath(cwd)),
        generatedAt: lintReport.generatedAt ?? null,
        ok: Boolean(lintReport.ok),
        errorCount: lintReport.errorCount ?? null,
        blocking: lintReport.lint?.blocking ?? null,
        decks: Object.fromEntries((lintReport.decks ?? []).map((deck) => [
          deck.deck,
          {
            ok: deck.lint?.ok ?? null,
            counts: deck.lint?.counts ?? null,
          },
        ])),
      }
    : null;
  return {
    schema: "lattice.portal-status.v1",
    generatedAt: new Date().toISOString(),
    project: config.title,
    validate: validateReport,
    lint: lintSummary,
    lintSource: lintSummary ? null : { expected: rel(cwd, lintReportPath(cwd)), hint: "run lattice inspect --rendered --lint --out .lattice/inspections/latest.json" },
    decks: deckIds.map((deckId) => deckStatusSummary({
      cwd,
      deckId,
      deckDir: path.join(decksDir, deckId),
      validate: validateReport.decks?.[deckId] ?? { pass: false, reason: "not covered by the cached validate run" },
      lint: lintSummary?.decks?.[deckId] ?? null,
    })),
  };
}

async function runValidateSubprocess(cwd, deckId = null) {
  const cliEntry = fileURLToPath(new URL("../index.js", import.meta.url));
  const args = deckId ? ["validate", "--deck", deckId] : ["validate"];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliEntry, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ status: 1, stdout, stderr: `${stderr}\nvalidate timed out` });
    }, 120000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * One real `lattice validate` subprocess per deck (in parallel). The exit
 * code is the machine-consumable truth; the human-readable tail is kept for
 * the review view.
 */
async function defaultRunValidate({ cwd, deckIds }) {
  const results = await Promise.all(deckIds.map(async (deckId) => {
    const result = await runValidateSubprocess(cwd, deckId);
    return [deckId, {
      pass: result.status === 0,
      exitCode: result.status,
      output: (result.status === 0 ? result.stdout : result.stderr).trim().split("\n").slice(-4),
    }];
  }));
  const decks = Object.fromEntries(results);
  const pass = deckIds.length > 0 && Object.values(decks).every((entry) => entry.pass);
  return {
    schema: "lattice.portal-validate.v1",
    pass,
    at: new Date().toISOString(),
    decks,
  };
}

// ---- Portal pages -----------------------------------------------------------

const PORTAL_STYLE = `
  :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 16px; line-height: 1.4; --ink: #252529; --muted: #606069; --line: #e1e1e6; --soft: #f0f0f4; --accent: #1672d4; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #fafafa; color: var(--ink); }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  a:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: .35rem; }
  .slides-shell { display: flex; align-items: flex-start; gap: 20px; max-width: 1350px; margin: 0 auto; padding: 32px; }
  .slides-sidebar { width: 160px; flex-shrink: 0; position: sticky; top: 32px; line-height: 1.4; }
  .slides-brand { padding: 0 .5rem 1rem; font-size: 1rem; font-weight: 650; letter-spacing: -.02em; }
  .slides-brand span { display: block; margin-top: .15rem; font-size: .72rem; font-weight: 400; letter-spacing: .02em; color: var(--muted); }
  .slides-nav-entry { display: flex; align-items: center; gap: .5rem; min-height: 2.25rem; padding: .45rem .5rem; border-radius: .5rem; font-size: .875rem; color: inherit; }
  .slides-nav-entry:hover { background: var(--soft); text-decoration: none; }
  .slides-nav-entry[aria-current] { background: var(--soft); font-weight: 650; }
  .slides-nav-entry svg { width: 1.125rem; height: 1.125rem; flex-shrink: 0; fill: none; stroke: var(--accent); stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
  .slides-count { margin-left: auto; font-size: .75rem; font-weight: 400; color: var(--muted); }
  .slides-main { flex: 1; min-width: 0; }
  .slides-heading { margin-bottom: 1.5rem; }
  h1 { margin: 0; font-size: 1.45rem; font-weight: 650; letter-spacing: -.02em; line-height: 1.35; overflow-wrap: anywhere; }
  h2 { font-size: 1rem; font-weight: 600; }
  .deck-card { padding: 1.1rem 0 1.25rem; border-bottom: 1px solid var(--line); }
  .deck-card:first-child { padding-top: 0; }
  .deck-card h2 { margin: 0; font-size: 1.05rem; line-height: 1.45; overflow-wrap: anywhere; }
  .deck-title { color: inherit; }
  .deck-title:hover { color: var(--accent); }
  .deck-meta { color: var(--muted); font-size: .8125rem; margin: .5rem 0 0; overflow-wrap: anywhere; }
  .status-row { display: flex; flex-wrap: wrap; gap: .4rem .65rem; margin: .75rem 0; }
  .pill { font-size: .75rem; padding: .15rem .45rem; border-radius: .35rem; color: var(--muted); background: var(--soft); }
  .pill.pass { color: #236147; background: #e9f2ec; }
  .pill.fail { color: #a13428; background: #f8ecea; }
  .pill.warn { color: var(--muted); background: var(--soft); }
  .entries { display: flex; flex-wrap: wrap; gap: .4rem .65rem; margin-top: .8rem; }
  .entries a { display: inline-flex; align-items: center; justify-content: center; min-height: 2.25rem; padding: .35rem .7rem; border: 1px solid var(--line); border-radius: .5rem; background: #fff; font-size: .8125rem; }
  .entries a:hover { background: var(--soft); text-decoration: none; }
  .entries .primary { color: var(--accent); }
  .review-section { margin-top: 1.75rem; }
  .review-section > h2 { margin: 0 0 .8rem; }
  .review-table-wrap { overflow-x: auto; }
  .review-table { width: 100%; border-collapse: collapse; font-size: .8125rem; }
  .review-table th, .review-table td { border-bottom: 1px solid var(--line); padding: .65rem .5rem; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
  .review-table th { color: var(--muted); font-weight: 600; white-space: nowrap; }
  .review-table td { min-width: 6rem; max-width: 24rem; }
  code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: .85em; background: var(--soft); padding: .1rem .25rem; border-radius: .25rem; }
  pre { max-width: 100%; background: var(--soft); padding: 1rem; border-radius: .5rem; overflow-x: auto; font-size: .8125rem; line-height: 1.6; }
  .empty { color: var(--muted); font-size: .875rem; }
  .skip-link { position: absolute; left: 1rem; top: -10rem; padding: .6rem; background: #fff; }
  .skip-link:focus { top: .5rem; }
  @media (max-width: 760px) {
    .slides-shell { flex-direction: column; gap: 24px; padding: 16px; }
    .slides-sidebar { width: 100%; position: static; }
    .slides-sidebar nav { display: flex; }
    .slides-nav-entry { min-height: 44px; gap: .5rem; }
    .slides-count { padding-left: .5rem; }
    .slides-main { width: 100%; }
    .entries a { min-height: 44px; padding-inline: .85rem; }
    .slides-heading { margin-bottom: 1.25rem; }
  }
`;

function pill(label, tone) {
  return `<span class="pill ${tone}">${escapeHtml(label)}</span>`;
}

function validatePill(validate) {
  if (validate?.pass === true) return pill("内容检查通过", "pass");
  if (validate?.pass === false) return pill("内容需要检查", "fail");
  return pill("尚未检查内容", "warn");
}

function lintPill(lint) {
  if (!lint) return pill("尚未检查版式", "warn");
  if (lint.ok === true) return pill("版式正常", "pass");
  if (lint.ok === false) {
    const total = Object.values(lint.counts ?? {}).reduce((sum, count) => sum + (count ?? 0), 0);
    return pill(`${total}项版式提示`, "fail");
  }
  return pill("版式检查暂无结果", "warn");
}

function lockPill(lock) {
  if (!lock) return pill("内容锁定状态未知", "warn");
  return lock.locked ? pill("内容已锁定", "pass") : pill("内容未锁定", "warn");
}

function provenancePill(provenance) {
  if (!provenance) return "";
  return provenance.total > 0 ? pill(`${provenance.total}次变更`, "warn") : pill("暂无变更", "warn");
}

function sidebar(status, current = false) {
  return `<aside class="slides-sidebar" aria-label="文稿导航">
    <div class="slides-brand">Slides<span>演示文稿</span></div>
    <nav aria-label="文稿"><a class="slides-nav-entry" href="/"${current ? ' aria-current="page"' : ""}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01"/></svg>
      <span>全部文稿</span><span class="slides-count">${status.decks.length}</span>
    </a></nav>
  </aside>`;
}

function deckEntries(deck) {
  return `<div class="entries" aria-label="文稿操作">
    <a class="primary" href="${escapeHtml(deck.entries.viewer)}">查看</a>
    <a href="${escapeHtml(deck.entries.present)}">演示</a>
    <a href="${escapeHtml(deck.entries.workbench)}">视频</a>
    <a href="${escapeHtml(deck.entries.review)}">审阅</a>
  </div>`;
}

export function renderPortalHome(status) {
  const deckCards = status.decks.map((deck) => `
    <section class="deck-card" data-deck="${escapeHtml(deck.id)}">
      <h2><a class="deck-title" href="${escapeHtml(deck.entries.viewer)}">${escapeHtml(deck.title)}</a></h2>
      ${deck.presenter ? `<p class="deck-meta">主讲：${escapeHtml(deck.presenter)}</p>` : ""}
      <div class="status-row">
        ${validatePill(deck.validate)}${lintPill(deck.lint)}${lockPill(deck.lock)}${provenancePill(deck.provenance)}
      </div>
      ${deckEntries(deck)}
    </section>
  `).join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Slides</title>
<style>${PORTAL_STYLE}</style>
</head>
<body>
<a class="skip-link" href="#slides-main">跳到文稿</a>
<div class="slides-shell">
  ${sidebar(status, true)}
  <main class="slides-main" id="slides-main" tabindex="-1">
    <div class="slides-heading"><h1>演示文稿</h1></div>
    <div class="deck-list">${deckCards || '<p class="empty">这里还没有文稿。</p>'}</div>
  </main>
</div>
</body>
</html>
`;
}

export function renderReviewView({ cwd, deckId, status }) {
  const provenance = readProvenanceRecords(cwd, deckId, { limit: 50 });
  const deck = status.decks.find((entry) => entry.id === deckId);
  const rows = provenance.records.map((record) => `
    <tr>
      <td>${escapeHtml(record.when ?? "")}</td>
      <td>${escapeHtml(record.actor ?? "")}</td>
      <td>${escapeHtml([record.command, record.field ?? "", record.slide ?? ""].filter(Boolean).join(" / "))}</td>
      <td>${escapeHtml(record.reason ?? "")}</td>
      <td><code>${escapeHtml((record.outputs?.sha256 ?? "").slice(0, 12))}</code></td>
    </tr>
  `).join("");
  const lintSection = status.lint
    ? (status.lint.decks?.[deckId]
      ? `<pre>${escapeHtml(JSON.stringify(status.lint.decks[deckId], null, 2))}</pre>`
      : '<p class="empty">最近的版式报告中没有这份文稿的记录。</p>')
    : '<p class="empty">暂无版式检查记录。</p>';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${escapeHtml(deck?.title ?? deckId)} · 审阅</title>
<style>${PORTAL_STYLE}</style>
</head>
<body>
<a class="skip-link" href="#slides-main">跳到审阅记录</a>
<div class="slides-shell">
  ${sidebar(status)}
  <main class="slides-main" id="slides-main" tabindex="-1">
    <div class="slides-heading"><h1>${escapeHtml(deck?.title ?? deckId)}</h1>${deck ? deckEntries(deck) : ""}</div>
    <section class="review-section"><h2>文稿状态</h2>
      <div class="status-row">${validatePill(deck?.validate)}${lintPill(deck?.lint)}${lockPill(deck?.lock)}${provenancePill(deck?.provenance)}</div>
    </section>
    <section class="review-section"><h2>版式检查</h2>${lintSection}</section>
    <section class="review-section"><h2>变更记录（${provenance.total}条）</h2>
      <div class="review-table-wrap"><table class="review-table">
        <thead><tr><th>时间</th><th>操作者</th><th>变更</th><th>原因</th><th>输出摘要</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5">暂无变更记录。</td></tr>'}</tbody>
      </table></div>
    </section>
  </main>
</div>
</body>
</html>
`;
}

/**
 * Install the portal middlewares on the shared dev server. Everything under
 * /lattice/portal is served by this module; the root path renders the portal
 * home only when the request is not a deck view (no ?deck= / ?present=).
 */
export function installPortalMiddleware({ cwd, config, server }) {
  let statusCache = null;
  let statusCacheKey = null;

  const decksTreeKey = () => {
    const decksDir = path.resolve(cwd, config.decksDir);
    const locksDir = path.resolve(cwd, ".lattice", "content-locks");
    const provenance = provenanceDir(cwd);
    const stat = (target) => {
      try {
        return fs.statSync(target).mtimeMs;
      } catch {
        return 0;
      }
    };
    return [decksDir, locksDir, provenance].map(stat).join(":");
  };

  const middlewares = server.middlewares;
  middlewares.use("/lattice/portal/decks", async (req, res, next) => {
    if (req.method !== "GET") { next(); return; }
    const key = decksTreeKey();
    if (statusCache === null || statusCacheKey !== key) {
      statusCache = await collectPortalStatus({ cwd, config });
      statusCacheKey = key;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.searchParams.get("refresh") === "1") {
      statusCache = await collectPortalStatus({ cwd, config });
      statusCacheKey = decksTreeKey();
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(statusCache, null, 2));
  });

  // Issue 005: the workbench is a deck-scoped route of this portal — no
  // second port, no lazy start. The handler module lives under video/ and is
  // therefore reached only through this dynamic import (the A35 load
  // boundary): the portal's static module graph never contains video code,
  // and the workbench module opens no port of its own.
  let workbenchHandlerPromise = null;
  middlewares.use("/workbench", (req, res, next) => {
    if (workbenchHandlerPromise === null) {
      workbenchHandlerPromise = import("../video/ui/server.js")
        .then((module) => module.createWorkbenchHandler({ cwd, config }))
        .catch((error) => {
          workbenchHandlerPromise = null;
          throw error;
        });
    }
    workbenchHandlerPromise.then((handler) => handler(req, res, next)).catch((error) => {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: `workbench route failed to load: ${error.message}` }, null, 2));
    });
  });

  middlewares.use("/lattice/portal/deck/", (req, res, next) => {
    if (req.method !== "GET") { next(); return; }
    const match = String(req.url ?? "").match(/^\/([^/]+)\/review\/?$/);
    if (!match) { next(); return; }
    const deckId = decodeURIComponent(match[1]);
    const deckDir = path.join(path.resolve(cwd, config.decksDir), deckId);
    if (!fs.existsSync(deckDir)) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(`unknown deck: ${deckId}`);
      return;
    }
    collectPortalStatus({ cwd, config }).then((status) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(renderReviewView({ cwd, deckId, status }));
    }).catch((error) => {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(`portal status failed: ${error.message}`);
    });
  });

  middlewares.use((req, res, next) => {
    if (req.method !== "GET") { next(); return; }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/" || url.searchParams.has("deck")) { next(); return; }
    collectPortalStatus({ cwd, config }).then((status) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(renderPortalHome(status));
    }).catch((error) => {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(`portal status failed: ${error.message}`);
    });
  });
}
