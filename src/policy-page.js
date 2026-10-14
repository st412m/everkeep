'use strict';
/**
 * Everkeep — the "Vault policies" page (policy_page mode "ha-ingress")
 *
 * It runs its own HTTP server on its own port (policy_page.port, 3101, Home
 * Assistant ingress, not published in the app's `ports:`). Markers are written
 * through policy-write.js; the MCP dispatcher has no reference to it.
 *
 * Per Home Assistant's add-on docs, ingress traffic arrives only from
 * 172.30.32.2; every other source is refused. The base URL is taken from the
 * X-Ingress-Path header the gateway adds.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const P = require('./policy');
const SP = require('./safepath');
const W = require('./policy-write');
const { VERSION } = require('./version');

const SUPERVISOR_IP = '172.30.32.2';
// Local testing only (`ALLOW_LOCAL=true`).
const ALLOW_LOCAL = process.env.ALLOW_LOCAL === 'true';

// Set by createPolicyPage(). ROOT is the branded vault root; anything sent as
// JSON takes `.path`.
let R = null;
let ROOT = null;

function fromSupervisor(req) {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (ip === SUPERVISOR_IP) return true;
  return ALLOW_LOCAL && (ip === '127.0.0.1' || ip === '::1');
}

// policy_page.users. Empty = every HA user.
let PAGE_USERS = [];
const NOT_LISTED = 'Forbidden: this Home Assistant user is not listed in policy_page_users\n';

// Exactly one X-Remote-User-Id and at most one X-Remote-User-Name, header
// names in any case; a second copy is treated as forged. The ID or the name
// must equal an entry of the list exactly.
function pageUserAllowed(rawHeaders, allowList) {
  if (!allowList || !allowList.length) return true;
  const ids = [], names = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const k = String(rawHeaders[i]).toLowerCase();
    if (k === 'x-remote-user-id') ids.push(String(rawHeaders[i + 1]));
    else if (k === 'x-remote-user-name') names.push(String(rawHeaders[i + 1]));
  }
  if (ids.length !== 1 || names.length > 1) return false;
  return allowList.includes(ids[0]) || (names.length === 1 && allowList.includes(names[0]));
}

// ---------------------------------------------------------------------------
// Tree: the root and the directories directly in it.
// ---------------------------------------------------------------------------

// Three outcomes. trashDirOf() is lexical, so a trash that is not a directory
// (a symlink included) counts as unknown: null, shown without a number, and
// refused by the sweep on the same lstat. A trash that does not exist yet
// counts 0: the first trash_file creates it.
function countTrash(trashDir) {
  let st;
  try { st = fs.lstatSync(trashDir.path); }
  catch (e) { return e.code === 'ENOENT' ? 0 : null; }
  if (!st.isDirectory()) return null;
  let n = 0;
  const walk = (d, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(d.path, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) walk(SP.child(d, e.name), depth + 1);
      else if (e.isFile()) n++;
    }
  };
  walk(trashDir, 0);
  return n;
}

function ownMarker(dir) {
  try { return fs.lstatSync(SP.child(dir, P.POLICY_FILE).path).isFile(); } catch { return false; }
}

function describeEntry(dir, memo) {
  const policy = P.policyForDir(dir, ROOT, memo);
  const own = ownMarker(dir);
  const trashDir = P.trashDirOf(policy);
  const out = {
    path: dir.path,
    name: path.basename(dir.path),
    own,
    error: policy.error,
    mode: own ? modeOf(policy) : 'inherit',
    effective: modeOf(policy),
    trash: !!policy.trash,
    trashName: policy.trash || P.DEFAULT_TRASH,
    trashOwn: trashDir ? policy.trashOwner.path === dir.path : false,
    // The directory whose trash this one shares, when it is not its own.
    trashOwner: trashDir ? policy.trashOwner.path : null,
    trashCount: null,
    retention_enabled: !!policy.retention_enabled,
    retention_days: policy.retention_days || 30,
    source: policy.source,
    summary: P.describePolicy(policy, dir.path),
  };
  if (trashDir && out.trashOwn) out.trashCount = countTrash(trashDir);
  return out;
}

function modeOf(policy) {
  if (policy.readonly) return 'readonly';
  return policy.overwrite;   // 'rev' | 'never' | 'free'
}

function buildTree() {
  const memo = new Map();
  const root = describeEntry(ROOT, memo);
  const rootPolicy = P.policyForDir(ROOT, ROOT, memo);
  const rootTrash = P.trashDirOf(rootPolicy);
  const children = [];
  for (const e of fs.readdirSync(ROOT.path, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (P.SKIP_DIRS.has(e.name)) continue;
    const full = SP.child(ROOT, e.name);
    if (P.isTrashAt(full.path, rootTrash)) continue;   // the trash is not a zone to configure
    children.push(describeEntry(full, memo));
  }
  children.sort((a, b) => a.name.localeCompare(b.name));

  // Markers deeper than one level are not created here, but are listed.
  // Directories only, bounded, no file walking.
  // Compared as paths: scan.dirs holds brands, and two brands for the same
  // directory are different objects. samePath, because on a vault that
  // ignores case one directory can be spelled two ways.
  const scan = P.findMarkerDirs(ROOT, memo);
  const shallow = [ROOT.path, ...children.map(c => c.path)];
  const deeper = scan.dirs.filter(d => !shallow.some(s => SP.samePath(s, d.path))).map(d => {
    const pol = P.policyForDir(d, ROOT, memo);
    return { path: d.path, summary: P.describePolicy(pol, d.path), error: pol.error };
  });

  return { root, children, deeper, truncated: scan.truncated, vault: ROOT.path, version: VERSION };
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

function applyChange(body) {
  if (!body || typeof body.path !== 'string') throw new Error('path is required');
  const dir = W.targetDir(R, body.path);

  if (body.mode === 'inherit') {
    const t = W.removeMarker(dir);
    return `Marker removed: ${t} — this directory now follows the rule above it.`;
  }

  const t = W.writeMarker(R, dir, W.specOf(body, W.contextOf(R, dir)), 'ha-ingress');
  return `Saved: ${t}`;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
}

const listener = (req, res) => {
  if (!fromSupervisor(req)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden\n'); return; }
  if (!pageUserAllowed(req.rawHeaders, PAGE_USERS)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end(NOT_LISTED); return; }

  const url = req.url.split('?')[0].replace(/\/+$/, '') || '/';

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    const base = (req.headers['x-ingress-path'] || '').replace(/\/+$/, '');
    const body = Buffer.from(page(base), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
    res.end(body);
    return;
  }

  if (req.method === 'GET' && url === '/api/tree') {
    try { json(res, 200, buildTree()); }
    catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (req.method === 'POST' && url === '/api/policy') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const msg = applyChange(body);
        json(res, 200, { ok: true, message: msg });
      } catch (e) {
        json(res, 400, { ok: false, error: e.message });
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found\n');
};

// One page per process, over the vault of the MCP server. Returns the HTTP
// server, not listening yet.
function createPolicyPage({ vault, users = [] }) {
  if (R) throw new Error('the policy page is already set up for this process');
  R = SP.createResolver(vault);
  // The page exists only in mode "ha-ingress": refusals name it.
  P.setEditorMode('ha-ingress');
  ROOT = R.root;
  PAGE_USERS = users.map(s => String(s).trim()).filter(Boolean);
  return http.createServer(listener);
}

// Start lines for the log.
function startLines(port) {
  const lines = [`everkeep: policy page on port ${port} (ingress), vault ${ROOT.path}`];
  if (!PAGE_USERS.length)
    lines.push('everkeep: policy page is open to every Home Assistant user (policy_page_users is empty)');
  return lines;
}

module.exports = { createPolicyPage, startLines, pageUserAllowed };

// ---------------------------------------------------------------------------
// The page itself
// ---------------------------------------------------------------------------

function page(base) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vault policies</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 24px;
         background: var(--primary-background-color, #fafafa); color: var(--primary-text-color, #212121); }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #888; font-size: 13px; margin-bottom: 20px; }
  table { border-collapse: collapse; width: 100%; max-width: 900px; }
  td { padding: 10px 8px; border-bottom: 1px solid rgba(127,127,127,.25); vertical-align: middle; }
  td.name { font-family: ui-monospace, "SF Mono", Menlo, monospace; white-space: nowrap; }
  .root td.name { font-weight: 600; }
  .hint { color: #888; font-size: 12px; }
  select, input[type=number] { padding: 5px; font: inherit; }
  input[type=number] { width: 64px; }
  label.chk { margin-right: 14px; font-size: 13px; white-space: nowrap; }
  .opts { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; }
  .err { color: #c62828; font-size: 13px; }
  .deeper { max-width: 900px; margin-top: 28px; font-size: 13px; }
  .deeper div.row { padding: 8px 0; border-bottom: 1px solid rgba(127,127,127,.25); display: flex;
                    justify-content: space-between; gap: 12px; align-items: center; }
  button { font: inherit; padding: 5px 10px; cursor: pointer; }
  #msg { position: sticky; bottom: 0; padding: 10px 0; font-size: 13px; }
  .note { max-width: 900px; margin-top: 28px; font-size: 13px; color: #888; line-height: 1.5; }
</style>
</head><body>
<h1>Vault policies</h1>
<div class="sub" id="sub">loading…</div>
<table id="tbl"></table>
<div class="deeper" id="deeper"></div>
<div class="note">
  A policy applies to its directory and everything below it, until a deeper marker overrides it.
  Put policies on the top-level directories and let the rest inherit; if some nested directory needs
  its own rule, it is usually cleaner to lift that directory up here.
  <br><br>
  <b>Read-only</b> stops this add-on's tools. It does not stop anything else that writes to the vault
  — a Home Assistant <code>shell_command</code> copying files in, Samba, the file editor — those go
  straight to the filesystem and never see these markers.
</div>
<div id="msg"></div>
<script>
const BASE = ${JSON.stringify(base)};
const MODES = [["inherit","inherits"],["readonly","read-only"],["rev","edits with rev"],["free","free writes"],["never","new files only"]];
let DATA = null;

function el(t, a, kids) {
  const n = document.createElement(t);
  for (const k in (a||{})) { if (k === "class") n.className = a[k]; else if (k.startsWith("on")) n[k] = a[k]; else n.setAttribute(k, a[k]); }
  for (const c of (kids||[])) n.append(c);
  return n;
}

async function load() {
  const r = await fetch(BASE + "/api/tree");
  DATA = await r.json();
  if (DATA.error) { document.getElementById("sub").textContent = DATA.error; return; }
  document.getElementById("sub").textContent = DATA.vault + " · everkeep " + DATA.version;
  render();
}

function row(e, isRoot) {
  const modes = isRoot ? MODES.filter(m => m[0] !== "inherit") : MODES;
  const sel = el("select");
  for (const [v, t] of modes) {
    const o = el("option", { value: v }); o.textContent = t;
    if (v === e.mode) o.selected = true;
    sel.append(o);
  }
  sel.onchange = () => save(e, { mode: sel.value });

  const opts = el("div", { class: "opts" });
  if (e.mode !== "inherit" && e.mode !== "readonly") {
    const cb = el("input", { type: "checkbox" });
    cb.checked = e.trash;
    cb.onchange = () => save(e, { trash: cb.checked });
    const lab = el("label", { class: "chk" }, [cb, document.createTextNode(
      " trash" + (e.trashCount !== null ? " (" + e.trashCount + ")" : "") +
      (e.trash && !e.trashOwn && e.trashOwner ? " — shared with " + e.trashOwner : ""))]);
    opts.append(lab);

    // Auto-purge belongs to the directory that owns the trash.
    if (e.trash && e.trashOwn) {
      const rc = el("input", { type: "checkbox" });
      rc.checked = e.retention_enabled;
      rc.onchange = () => save(e, { retention_enabled: rc.checked });
      opts.append(el("label", { class: "chk" }, [rc, document.createTextNode(" auto-purge")]));
      const days = el("input", { type: "number", min: "1", max: "3650", value: String(e.retention_days) });
      days.onchange = () => save(e, { retention_days: parseInt(days.value, 10) });
      opts.append(days);
      opts.append(el("span", { class: "hint" }, [document.createTextNode(" days")]));
    }
  }

  const right = e.error
    ? el("div", { class: "err" }, [document.createTextNode(e.error)])
    : el("div", { class: "hint" }, [document.createTextNode(
        e.mode === "inherit" ? ("← " + (e.source ? e.source : "no marker above — unrestricted")) : "")]);

  return el("tr", { class: isRoot ? "root" : "" }, [
    el("td", { class: "name" }, [document.createTextNode(isRoot ? e.name + "/" : "└ " + e.name + "/")]),
    el("td", {}, [sel]),
    el("td", {}, [opts]),
    el("td", {}, [right]),
  ]);
}

function render() {
  const t = document.getElementById("tbl");
  t.textContent = "";
  t.append(row(DATA.root, true));
  for (const c of DATA.children) t.append(row(c, false));

  const d = document.getElementById("deeper");
  d.textContent = "";
  if (DATA.deeper.length) {
    d.append(el("b", {}, [document.createTextNode("Markers placed deeper than one level")]));
    for (const x of DATA.deeper) {
      const btn = el("button", { onclick: () => save({ path: x.path }, { mode: "inherit" }) });
      btn.textContent = "remove";
      d.append(el("div", { class: "row" }, [
        el("span", {}, [document.createTextNode(x.path + " — " + x.summary)]), btn
      ]));
    }
  }
  if (DATA.truncated) d.append(el("div", { class: "hint" }, [document.createTextNode(
    "The scan for deeper markers hit its limit; some may not be listed.")]));
}

async function save(entry, change) {
  const cur = DATA.children.concat([DATA.root]).find(x => x.path === entry.path) || entry;
  const body = {
    path: entry.path,
    mode: change.mode !== undefined ? change.mode : (cur.mode === "inherit" ? cur.effective : cur.mode),
    trash: change.trash !== undefined ? change.trash : !!cur.trash,
    trashName: cur.trashName,
    retention_enabled: change.retention_enabled !== undefined ? change.retention_enabled : !!cur.retention_enabled,
    retention_days: change.retention_days !== undefined ? change.retention_days : cur.retention_days,
  };
  const msg = document.getElementById("msg");
  try {
    const r = await fetch(BASE + "/api/policy", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    const j = await r.json();
    msg.textContent = j.ok ? j.message : ("Error: " + j.error);
    msg.className = j.ok ? "hint" : "err";
  } catch (e) {
    msg.textContent = "Error: " + e.message; msg.className = "err";
  }
  await load();
}

load();
</script>
</body></html>`;
}
