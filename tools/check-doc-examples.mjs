#!/usr/bin/env node
// Checks the examples in the documentation against the source.
//
//   node tools/check-doc-examples.mjs [app-root]
//
// Everkeep: README.md and docs/*.md against src/, scripts/, the Dockerfile,
// compose.example.yaml, everkeep.example.json, package.json, server.json, the
// workflows, and doclines' own source (the texts Everkeep passes through).
// With app-root (the ha-filesystem-mcp repository) also its README.md and
// filesystem_mcp/DOCS.md, against the same source plus the app's run.sh,
// config.yaml and Dockerfiles.
//
// Checked:
// - every inline `code` span is found in the source, is a tool name, or is in
//   the EXTERNAL list below (user content, commands of other programs, UI
//   names); "<placeholder>" and "…" stand for parts the source fills in;
// - output lines in fenced blocks that look like server output match a
//   template string of the source;
// - `everkeep …` command lines use commands and flags the CLI has;
// - JSON blocks that are Everkeep configs pass the config parser;
// - error codes named in the docs exist; docs/tools.md covers exactly TOOLS;
// - relative links resolve, links into the GitHub repositories point to files
//   that exist; DOCS.md uses absolute links only (Home Assistant shows it
//   outside the repository).
// Exit code 1 if any check fails.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP = process.argv[2] ? path.resolve(process.argv[2]) : null;
const require = createRequire(import.meta.url);
const CYR = /[\u0400-\u04FF]/;
// A word character: letter, number or underscore.
const W = '[\\p{L}\\p{N}_]';

function read(root, p) {
  return fs.readFileSync(path.join(root, p), 'utf8');
}

function listDir(root, dir, ext) {
  const full = path.join(root, dir);
  return fs.readdirSync(full)
    .filter(n => !n.startsWith('.') && n.endsWith(ext) && fs.statSync(path.join(full, n)).isFile())
    .map(n => `${dir}/${n}`);
}

const DOCLINES = path.dirname(require.resolve('doclines/package.json'));

const SRC_FILES = [
  ...listDir(ROOT, 'src', '.js').map(p => [ROOT, p]),
  ...listDir(ROOT, 'scripts', '.sh').map(p => [ROOT, p]),
  ...listDir(ROOT, 'test', '.js').map(p => [ROOT, p]),
  ...listDir(ROOT, '.github/workflows', '.yml').map(p => [ROOT, p]),
  ...['Dockerfile', 'compose.example.yaml', 'everkeep.example.json', 'package.json', 'server.json'].map(p => [ROOT, p]),
  ...listDir(DOCLINES, 'src', '.js').map(p => [DOCLINES, p]),
  ...(APP ? ['filesystem_mcp/run.sh', 'filesystem_mcp/config.yaml', 'filesystem_mcp/Dockerfile', 'filesystem_mcp/Dockerfile.local'].map(p => [APP, p]) : []),
];
const SRC = SRC_FILES.map(([r, p]) => read(r, p)).join('\n');
const SERVER = read(ROOT, 'src/server.js');
const CLI = require(path.join(ROOT, 'src/cli.js'));
const CONFIG = require(path.join(ROOT, 'src/config.js'));

const DOC_FILES = [
  ...['README.md', ...listDir(ROOT, 'docs', '.md').sort()].map(p => ({ root: ROOT, file: p, name: p })),
  ...(APP ? ['README.md', 'filesystem_mcp/DOCS.md'].map(p => ({ root: APP, file: p, name: `app/${p}` })) : []),
];
for (const d of DOC_FILES) d.text = read(d.root, d.file);

function squash(s) {
  return s.replace(/["'\\]/g, '').replace(/\s+/g, ' ');
}

const SRC_SQ = squash(SRC);

// --- TOOLS array --------------------------------------------------------------
const toolsBlock = SERVER.slice(SERVER.indexOf('const TOOLS = ['), SERVER.indexOf('async function callTool'));
const TOOLS = [...toolsBlock.matchAll(/^\s{4}name: '([a-z_]+)'/gm)].map(m => m[1]);

// --- Spans that are not claims about the code --------------------------------
// User content, commands of other programs, Home Assistant and client UI
// values, example data. Every entry is a deliberate exception and is counted
// in the output.
const EXTERNAL = new Set([
  // shell, Docker and other programs
  'docker ps', 'docker logs everkeep', 'docker restart everkeep', 'docker rm -f everkeep-tunnel', 'id -u', 'curl',
  'everkeep-notes', 'everkeep-data', 'tailscale funnel --bg 3100 off', 'cloudflared', '--http-host-header localhost:3100',
  '<device>.<tailnet>.ts.net', 'explorer $HOME\\everkeep-notes', 'open ~/everkeep-notes', 'scp',
  // folders a user might make in the vault
  'contracts/', 'invoices/2026/', 'projects/<name>/', 'projects/…',
  '-p 127.0.0.1:3100:3100', '"command": "npx"', '"args": ["--yes", "--package=everkeep", "everkeep", "--vault", "/home/me/notes"]',
  'npm install -g', 'npm install -g everkeep', '--omit=optional', 'rsync --delete', '--backup-dir',
  'npm_config_omit=optional npx --yes --package=everkeep everkeep serve --vault /home/me/notes',
  'npx --yes --package=everkeep everkeep token', '~/.config/systemd/user/everkeep.service',
  'node --test "test/*.test.js"', 'node:test', 'node tools/check-release.mjs',
  'test/*.test.js', 'test/casefold.test.js', 'tools/check-doc-examples.mjs', 'tools/scan-secrets.mjs', 'tools/check-release.mjs',
  '.github/workflows/ci.yml', '.github/workflows/image.yml',
  'npm pack', 'node --check', 'fork()', 'execArgv: []', 'execFile', 'callTool()', 'resolveSafe()', 'guardWrite()', 'guardOverwrite()',
  'sameName()', 'samePath()', 'meta(title, h)', "{ type: 'text', text }", 'image', 'audio', 'TOOLS', 'description', 'inputSchema', 'name',
  'case', 'isError: true', 'Error: ', 'listChanged: false', 'tools/list', '===', 'MIN_NODE_MAJOR', 'MIN_NODE_MINOR',
  'EXPECT_POPPLER_MAJOR', 'EXPECT_SQLITE_MAJOR', '`MIN_NODE_MAJOR`.`MIN_NODE_MINOR`', 'src/version.js', 'package.json', 'server.json',
  'Dockerfile', 'compose.example.yaml', 'everkeep.example.json', 'CHANGELOG.md', 'compose.yaml', 'README.md', 'LICENSE',
  // example data and paths in a user's vault
  'about-me.md', '/vault/about-me.md', 'todo.md', 'raw/', 'wiki/', 'raw/ha', 'raw/projects', 'wiki/projects', 'wiki/ha/{devices,automations,network}',
  'wiki/drafts', 'wiki', '/srv/notes', '/srv/notes_old', '/vault/docs/manual.pdf#3', 'wiki/system/foo.md', '/media/VAULT', '/media', '/share',
  '"*.md,*.yaml"', 'include="*.md,*.yaml"', '.fydb', '.db', 'x', '`x`', '+03:00', '2026-09-13 07:31:02 +03:00', '-1', '-2',
  '"Excel workbook (.xlsx)"', '"Word document (.docx)"', '"plain text"', 'changeme', 'CLAUDE.md', 'log.md',
  // SQL fragments suggested to the reader
  'hex(col)', 'length(col)', 'group_concat()', 'hex()',
  // line-edit shapes written as objects (the fields are checked separately)
  '{startLine: 10, endLine: 12, newText: "x"}', '{startLine: 10, endLine: 12, newText: ""}',
  '{startLine: 10, newText: "x"}', '{startLine: lines+1, newText: "x"}', '{startLine: 13, newText: "x"}',
  'startLine: 1', '{oldText, newText}', '{startLine, endLine, newText}', '{oldText}', '{startLine}',
  'newText: ""', 'dryRun: true', 'counts: true', 'lines', '\\n', '\\r\\n', '`#N`', '#N', '(a+)+', '.',
  // where a match sits, as printed by grep_files (sectionLabel() in server.js)
  'L8 (p.1)', 'L2 (sheet Data)', 'p.N', 'sheet <name>', 'slide N', 'chapter N', 'attachment <name>',
  'L<number> (<place>): <text>', '<number>: <text>', '<number>- <text>', 'Written:', 'Overwritten:',
  // HTTP and the connector URL
  'POST /mcp', 'GET', 'POST', 'Content-Type: application/json', 'Allow: POST, OPTIONS', 'Accept',
  'CF-Connecting-IP', 'X-Forwarded-For', 'Host', 'Origin', 'Bearer', '/private_<token>', '/private_<token>/mcp',
  'https://<your-host>/private_<token>/mcp', 'https://<your public address>/private_<token>/mcp', 'http://127.0.0.1:3100/mcp',
  'http://<ha-host>:3100/mcp', 'https://<device>.<tailnet>.ts.net', 'http://127.0.0.1:3100', 'http://localhost:3100',
  'https://<words>.trycloudflare.com', 'trycloudflare.com', '/mcp', 'localhost', '127.0.0.1', '[::1]', '0.0.0.0', '--host 0.0.0.0',
  '/.well-known/…', '(Host not local)', '(Origin not local)', '(not found)', '(unauthorized)', '/private_***',
  // Anthropic's published egress range, an external fact
  '160.79.104.0/21',
  // SQLite's own EXPLAIN QUERY PLAN vocabulary
  'CO-ROUTINE', 'SCAN (subquery-N)',
  // the Home Assistant app (its options and files are checked in the app source when given)
  'ha-filesystem-mcp', 'vault_path', 'media:rw', 'share:rw', 'ingress_port', '/data/doc-cache', '/data', '/vault', 'doc-cache', 'token',
  'raw/ha', 'everkeep 1.0.0 on 0.0.0.0:3100, vault /media/VAULT, …', 'everkeep 1.0.0 on 0.0.0.0:3100, vault /vault, …',
  // other clients' configuration
  '~/.cursor/mcp.json', '.cursor/mcp.json', 'claude_desktop_config.json', 'mcpServers', '%APPDATA%\\Claude\\',
  '~/Library/Application Support/Claude/', '%APPDATA%\\Claude\\logs', '~/Library/Logs/Claude', 'mcp-server-everkeep.log',
  ':/vault', 'npx',
  // other programs' commands, flags and messages
  'docker run', 'docker exec everkeep', 'tailscale up', '--bg', 'reverse_proxy', 'EACCES: permission denied', 'Illegal instruction',
  // a fragment of a config file; whole config blocks are parsed below
  '"log_requests": true',
  // a field of server.json, checked by tools/check-release.mjs
  'packages[0].version',
  // Alpine's package release suffix
  '-rN',
]);

// Templates of the source ---------------------------------------------------------
// Every template string with ${…} becomes a regex, ${…} matching anything.
// In .js files a scanner finds the template literals (nested ones included,
// comments and quoted strings skipped), and each line of a template written
// with \n is a regex of its own; other files are read with a simple pattern.
const PY_SPECIAL = new Set('()[]{}?*+-|^$\\.&~# \t\n\r\v\f');
function pyEscape(ch) {
  return PY_SPECIAL.has(ch) ? '\\' + ch : ch;
}

// A ${…} matches anything but " — ", the separator the server puts between a
// message and its advice: "<message> — <advice>" is then checked in both parts
// instead of the first hole swallowing the rest of the line.
const HOLE_RX = '(?:(?! — ).)*?';

function templateRegex(t) {
  let rx = '';
  let i = 0;
  while (i < t.length) {
    if (t.startsWith('${', i)) {
      let depth = 1, j = i + 2;
      while (j < t.length && depth) {
        if (t[j] === '{') depth++;
        else if (t[j] === '}') depth--;
        j++;
      }
      rx += HOLE_RX;
      i = j;
    } else {
      rx += pyEscape(t[i]);
      i++;
    }
  }
  return rx;
}

function jsTemplates(src) {
  const out = [];
  const skipQuote = start => {
    const q = src[start];
    let j = start + 1;
    while (j < src.length && src[j] !== q && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
    return j;
  };
  const readTemplate = start => {
    let j = start + 1;
    while (j < src.length) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '`') return j;
      if (c === '$' && src[j + 1] === '{') {
        let depth = 1;
        j += 2;
        while (j < src.length && depth) {
          const d = src[j];
          if (d === '`') { j = readTemplate(j) + 1; continue; }
          if (d === "'" || d === '"') { j = skipQuote(j) + 1; continue; }
          if (d === '{') depth++;
          else if (d === '}') depth--;
          j++;
        }
        continue;
      }
      j++;
    }
    return j;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); if (i < 0) break; i += 2; continue; }
    if (c === "'" || c === '"') { i = skipQuote(i) + 1; continue; }
    if (c === '`') { const end = readTemplate(i); out.push(src.slice(i + 1, end)); i = end + 1; continue; }
    i++;
  }
  return out;
}

const TEMPLATES = [];
function addTemplate(t) {
  if (!t.includes('${')) return;
  for (const piece of [t, ...t.split('\\n')]) {
    const rx = templateRegex(piece);
    // At least 7 characters of fixed text ("Saved: "): a template such as
    // "${a} · ${b}" would match almost any line.
    if (rx.split(HOLE_RX).join('').replace(/\\(.)/g, '$1').length >= 7) TEMPLATES.push(new RegExp('^' + rx + '$'));
  }
}
for (const [r, p] of SRC_FILES) {
  const text = read(r, p);
  if (p.endsWith('.js')) for (const t of jsTemplates(text)) addTemplate(t);
  else for (const m of text.matchAll(/`((?:[^`\\]|\\[^\n])*)`/g)) addTemplate(m[1]);
}

// Placeholders in docs (<path>, N, M, X, Y) stand for ${...} in the source.
const HOLE = '\x00';
const SRC_HOLES = SRC.replace(/\$\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, HOLE);

function holes(s) {
  s = s.replace(/<[^<>]+>/g, HOLE);
  return s.replace(new RegExp(`(?<!${W})[NMXY](?!${W})`, 'gu'), HOLE);
}

// Spans whose words must each appear in the source (object-shape examples).
const FIELD_WORDS = /[A-Za-z_]{3,}/g;

const results = { checked: 0, external: 0, commands: 0, configs: 0, failed: [] };

function fail(where, what) {
  results.failed.push(`${where}: ${what}`);
}

// A repository path that exists, such as `src/http.js`.
function existingPath(cand) {
  if (!/^[\w.-]+(?:\/[\w.-]+)+$/.test(cand)) return false;
  return fs.existsSync(path.join(ROOT, cand)) || (APP !== null && fs.existsSync(path.join(APP, cand)));
}

function found(cand) {
  if (SRC.includes(cand)) return true;
  if (existingPath(cand)) return true;
  if (TEMPLATES.some(t => t.test(cand))) return true;
  const sq = squash(cand);
  if (sq && SRC_SQ.includes(sq)) return true;
  const h = holes(cand);
  if (h.includes(HOLE) && SRC_HOLES.includes(h)) return true;
  return false;
}

function stripFences(text) {
  // Indentation only, never a line break: a fence inside a list item closes
  // at its own indentation.
  return text.replace(/^([ \t]*)(```|````)[^\n]*\n[\s\S]*?^\1\2[ \t]*$/gm, '');
}

// A line quoted repr()-style for the failure message.
function pyRepr(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = '';
  for (const ch of s) {
    if (ch === '\\') out += '\\\\';
    else if (ch === q) out += '\\' + q;
    else if (ch === '\n') out += '\\n';
    else if (ch.codePointAt(0) < 0x20 || ch.codePointAt(0) === 0x7f) out += '\\x' + ch.codePointAt(0).toString(16).padStart(2, '0');
    else out += ch;
  }
  return q + out + q;
}

// Inline backtick spans ---------------------------------------------------------
for (const d of DOC_FILES) {
  const body = stripFences(d.text);
  for (const [, span] of body.matchAll(/`([^`\n]+)`/g)) {
    results.checked++;
    if (TOOLS.includes(span)) continue;
    if (EXTERNAL.has(span)) {
      results.external++;
      // object-shaped examples: every field name must still exist
      if (span.startsWith('{')) {
        for (const [w] of span.matchAll(FIELD_WORDS)) {
          if (w !== 'lines' && w !== 'type' && w !== 'text' && !SRC.includes(w)) fail(d.name, `field \`${w}\` in \`${span}\` not in source`);
        }
      }
      continue;
    }
    // `everkeep …` commands are checked against the CLI, not as strings.
    if (/(^|\s)everkeep (serve|token|check-config|policy)\b/.test(span) || /^everkeep --/.test(span)) {
      checkCommand(d.name, span);
      continue;
    }
    const parts = span.split('…').map(p => p.trim()).filter(Boolean);
    if (!parts.every(found)) fail(d.name, `\`${span}\` not found in source`);
  }
}

// `everkeep …` commands ----------------------------------------------------------
// The text after the last "everkeep " that starts a command; flags and the
// subcommand must appear in the CLI's usage text.
function checkCommand(where, line) {
  const all = [...line.replace(/\\$/, '').matchAll(/(?:^|[\s"'=])everkeep(?=\s|$)((?:\s+[^\s|;&]+)*)/g)];
  const m = all.reverse().find(x => /^\s*(serve|token|check-config|policy|--vault|--version|--help)\b/.test(x[1]));
  if (!m) return;
  results.commands++;
  const words = m[1].trim().split(/\s+/).filter(Boolean);
  const sub = words[0] && !words[0].startsWith('-') ? words[0] : null;
  // `everkeep policy` or `everkeep policy set` alone names a command; it is
  // not an invocation.
  if (sub === 'policy' && (words.length === 1 || (words.length === 2 && ['show', 'set', 'clear'].includes(words[1])))) return;
  if (sub === 'policy' && !['show', 'set', 'clear'].includes(words[1])) {
    if (words[1].startsWith('-')) fail(where, `policy subcommand in ${pyRepr(line)}`);
    return;
  }
  for (const w of words) {
    if (!w.startsWith('--')) continue;
    const flag = w.split('=')[0];
    if (!CLI.USAGE.includes(flag)) fail(where, `flag ${flag} not in the CLI usage: ${pyRepr(line)}`);
  }
  if (sub === 'policy' && words[1] === 'set') {
    const rest = [];
    for (let i = 2; i < words.length; i++) {
      if (words[i] === '--vault') { i++; continue; }
      if (words[i].startsWith('--vault=')) continue;
      rest.push(words[i]);
    }
    const r = CLI.parseSetArgs(rest);
    if (r.error) fail(where, `policy set: ${r.error}: ${pyRepr(line)}`);
  }
}

// Fenced blocks: output lines, commands, configs ----------------------------------
// Lines that look like server output. "Error: " is the dispatcher's prefix and
// is matched without it; the rest of the line is a message of the source.
const FORMAT_LINE = /( · rev | · lines | · \d+ lines$| · no text layer$|^\[req\] |^\[retention\] |^Policy: |^⚠ Policy: |^— \d+ match|^\s+L?\d+(?: \([^)]*\))?[:-] |^Pages? \d|^everkeep[: ]\S|^Saved: |^Marker removed: |^No marker in |^Error: |^Markers at and below |^pages without text: |^--- |^\(no extractable |^\[(?:DIR|FILE)\] |^\d+\| |^ {2}(?:pdfinfo|pdftoppm|sqlite3|doclines): )/;

// Lines built from several short templates, as a shape plus the source text
// that builds them (which must still be there).
const SHAPES = [
  // a grep match or context line: "  148: text", "  L8 (p.1): text"
  [/^ {2}(?:L\d+(?: \([^)]+\))?|\d+)[:-] /, "`  ${numberOf(n)}${isHit ? ':' : '-'} ${clipAround(raw, at, raw.length, job.maxLineLength)}`"],
  // a document header: "<path> · <format> · [pages a-b of T · ]lines a-b of N"
  [/^\/\S* · [^·]+ · (?:pages \d+-\d+ of \d+ · )?lines \d+-\d+ of \d+$/, '`${p.path} · ${r.label}${extra} · ${range}'],
  // a listing entry
  [/^\[(?:DIR|FILE)\] \S/, "`${e.isDirectory() ? '[DIR]' : '[FILE]'} ${e.name}`"],
  // a numbered line of a document
  [/^\d+\| /, '`${n}| ${r.lines[n - 1]}`'],
];
// check-config's toolchain lines (cli.js)
SHAPES.push([/^ {2}(?:pdfinfo|pdftoppm|sqlite3|doclines): (?:\d[\d.]*|missing)$/, "`  ${bin}: ${v === null ? 'missing' : v}`"]);

function matchesSource(line) {
  const l = line.replace(/^Error: /, '');
  if (SRC.includes(l)) return true;
  if (TEMPLATES.some(t => t.test(l))) return true;
  if (SHAPES.some(([rx, needle]) => rx.test(line) && SRC.includes(needle))) return true;
  // A message that starts with a doclines message: check the server's suffix.
  const dash = l.indexOf(' — ');
  if (dash > 0 && found(l.slice(0, dash).replace(/: [^:]+$/, ': ')) && TEMPLATES.some(t => t.test(l.slice(dash)) || t.test('x' + l.slice(dash)))) return true;
  return false;
}

for (const d of DOC_FILES) {
  for (const [, info, block] of d.text.matchAll(/^[ \t]*```([^\n]*)\n([\s\S]*?)^[ \t]*```/gm)) {
    const lang = info.trim();
    if (lang === 'json') {
      let obj;
      try { obj = JSON.parse(block); } catch (e) { fail(d.name, `JSON block does not parse: ${e.message}`); continue; }
      if (obj && typeof obj === 'object' && !obj.mcpServers && ('vault' in obj || 'policy_page' in obj)) {
        results.configs++;
        try { CONFIG.parseConfig(obj, `${d.name} JSON block`); } catch (e) { fail(d.name, e.message); }
      }
      continue;
    }
    for (const raw of block.split('\n')) {
      const line = raw.replace(/^\s+(?=\S)/, m => (/^\s+L?\d+(?: \([^)]*\))?[:-] /.test(raw) ? m : ''));
      if (/(^|\s|")everkeep (serve|token|check-config|policy)\b|(^|\s)everkeep --vault\b|--package=everkeep everkeep/.test(line) && !/^everkeep: /.test(line) && !/^everkeep \d/.test(line)) {
        checkCommand(d.name, line);
        continue;
      }
      if (!FORMAT_LINE.test(line)) continue;
      results.checked++;
      if (matchesSource(line) || matchesSource(raw)) continue;
      fail(d.name, `output line matches no template: ${pyRepr(raw)}`);
    }
  }
}

// server.js templates that the documentation quotes must exist.
for (const needle of ['· rev ${revOf(text)} · ${lines.length} lines',
                      '· rev ${revOf(text)} · lines ${start}-${end} of ${lines.length}',
                      'match(es) in ${r.files} file(s) · scanned',
                      ': ${p.path} · rev ${revOf(args.content)}',
                      'lines ${before} → ${lines.length} · rev ${rev0} → ${rev1}',
                      'edit(s) applied to ${p.path} · rev ${rev0} → ${revOf(text)}',
                      "case 'page': return `p.${best.n}`;",
                      "case 'sheet': return `sheet ${best.label || best.n}`;"]) {
  results.checked++;
  if (!SERVER.includes(needle)) fail('server.js', `expected template missing: ${needle}`);
}

// No "Access denied" in docs ----------------------------------------------------
for (const d of DOC_FILES) {
  results.checked++;
  if (d.text.includes('Access denied')) fail(d.name, 'contains "Access denied"');
}

// No Cyrillic in echo lines of the shell scripts --------------------------------
const SH = [[ROOT, 'scripts/toolchain-check.sh'], ...(APP ? [[APP, 'filesystem_mcp/run.sh']] : [])];
for (const [r, f] of SH) {
  read(r, f).split('\n').forEach((line, i) => {
    if (/echo|bashio::log/.test(line)) {
      results.checked++;
      if (CYR.test(line)) fail(f, `line ${i + 1}: Cyrillic in a message`);
    }
  });
}

// Every error code named in the docs exists in the source ----------------------
const CODE_RE = new RegExp(`(?<!${W})([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?!${W})`, 'gu');
const NOT_CODES = new Set(['MIN_NODE_MAJOR', 'MIN_NODE_MINOR', 'EXPECT_POPPLER_MAJOR', 'EXPECT_SQLITE_MAJOR', 'X_FORWARDED_FOR', 'CF_CONNECTING_IP']);
const codesSeen = new Set();
for (const d of DOC_FILES) {
  for (const [, code] of d.text.matchAll(CODE_RE)) {
    if (NOT_CODES.has(code)) continue;
    codesSeen.add(code);
    results.checked++;
    if (!SRC.includes(code)) fail(d.name, `code ${code} is documented but not in the source`);
  }
}

// docs/tools.md covers exactly TOOLS ---------------------------------------------
const toolsMd = DOC_FILES.find(d => d.name === 'docs/tools.md').text;
const headed = [...toolsMd.matchAll(/^### `([a-z_]+)`$/gm)].map(m => m[1]);
for (const t of TOOLS) {
  results.checked++;
  if (!toolsMd.includes(`\`${t}\``)) fail('docs/tools.md', `tool ${t} not mentioned`);
}
for (const h of headed) {
  results.checked++;
  if (!TOOLS.includes(h)) fail('docs/tools.md', `heading ${h} is not in TOOLS`);
}
if (TOOLS.length !== 20) fail('server.js', `TOOLS has ${TOOLS.length} entries, expected 20`);

// Links ----------------------------------------------------------------------------
function slug(h) {
  return h.toLowerCase().replace(new RegExp(`[^\\p{L}\\p{N}_\\- ]`, 'gu'), '').trim().replaceAll(' ', '-');
}

const REPOS = { 'st412m/everkeep': ROOT, ...(APP ? { 'st412m/ha-filesystem-mcp': APP } : {}) };

function checkTarget(where, p, anchor, link) {
  if (!fs.existsSync(p)) { fail(where, `broken link ${link}`); return; }
  if (anchor && fs.statSync(p).isFile()) {
    const heads = [...fs.readFileSync(p, 'utf8').matchAll(/^#+ (.+)$/gm)].map(m => m[1]);
    if (!new Set(heads.map(slug)).has(anchor)) fail(where, `missing anchor ${link}`);
  }
}

for (const d of DOC_FILES) {
  for (const [, link] of d.text.matchAll(/\]\(([^)\s]+)\)/g)) {
    results.checked++;
    const hash = link.indexOf('#');
    const target = hash === -1 ? link : link.slice(0, hash);
    const anchor = hash === -1 ? '' : link.slice(hash + 1);
    const gh = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:blob|tree)\/main\/(.+)$/.exec(target);
    if (gh) {
      if (REPOS[gh[1]]) checkTarget(d.name, path.join(REPOS[gh[1]], gh[2]), anchor, link);
      continue;
    }
    if (d.name === 'app/filesystem_mcp/DOCS.md') {
      if (!link.startsWith('https://')) fail(d.name, `relative link ${link}`);
      continue;
    }
    if (/^https?:\/\//.test(link)) continue;
    const base = path.dirname(path.join(d.root, d.file));
    checkTarget(d.name, target ? path.normalize(path.join(base, target)) : path.join(d.root, d.file), anchor, link);
  }
}

console.log(`docs: ${DOC_FILES.map(d => d.name).join(', ')}`);
console.log(`tools in TOOLS: ${TOOLS.length}`);
console.log(`codes named in docs: ${codesSeen.size}`);
console.log(`candidates checked: ${results.checked}`);
console.log(`everkeep command lines checked: ${results.commands}`);
console.log(`config blocks parsed: ${results.configs}`);
console.log(`external (allow-listed, not code claims): ${results.external}`);
console.log(`failed: ${results.failed.length}`);
for (const f of results.failed) console.log('  FAIL ' + f);
process.exit(results.failed.length ? 1 : 0);
