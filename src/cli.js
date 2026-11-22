#!/usr/bin/env node
'use strict';
// Entry point. stdout belongs to the MCP protocol in stdio mode: logs go to
// stderr only.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs } = require('util');
const C = require('./config');
const { VERSION, DOCLINES_VERSION } = require('./version');

const USAGE = `everkeep ${VERSION}

Usage:
  everkeep [--vault DIR]       MCP server on stdio
  everkeep serve [--vault DIR] [--port 3100] [--host 127.0.0.1] [--token-file F]
                               MCP server over Streamable HTTP
  everkeep token [--new]       print the connector path and the Bearer line;
                               --new replaces the token
  everkeep check-config [--vault DIR]
                               validate the settings and the toolchain
  everkeep init [DIR] [--agent claude|other]
                               create a vault (default ~/everkeep) with an
                               instruction file and a starter policy, and
                               save it as the default vault
  everkeep policy show [DIR] [--vault DIR]
                               the policy in force at DIR (default: the vault root)
                               and every marker below it
  everkeep policy set DIR --mode readonly|rev|free|never
                      [--trash [NAME] | --no-trash] [--purge-days N | --no-purge]
                               write the marker of DIR
  everkeep policy clear DIR    remove the marker of DIR (it inherits again)
                               policy set and clear also take --vault DIR;
                               DIR: absolute, or relative to the vault root
  everkeep --version | --help
`;

function say(msg) {
  process.stderr.write(`everkeep: ${msg}\n`);
}

function usageError(msg) {
  say(`${msg}\n\n${USAGE}`);
  return 2;
}

function load(flags) {
  return C.loadConfig({ flags });
}

// Where the policy page is in mode "token".
const PAGE_PATH_NOTE = 'the connector path with /policies in place of /mcp';
const pagePath = token => `/private_${token}/policies`;

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

async function serveCommand(rest) {
  let opts;
  try {
    opts = parseArgs({
      args: rest,
      options: { vault: { type: 'string' }, port: { type: 'string' }, host: { type: 'string' }, 'token-file': { type: 'string' } },
    }).values;
  } catch (e) {
    return usageError(e.message);
  }
  const flags = { vault: opts.vault, host: opts.host };
  if (opts.port !== undefined) {
    flags.port = Number(opts.port);
    if (!/^\d+$/.test(opts.port) || flags.port > 65535) return usageError('--port must be an integer 0-65535');
  }
  if (opts.host === '') return usageError('--host must not be empty');

  const { resolveToken, connectionLines } = require('./token');
  const loaded = load(flags);
  const vault = C.requireVault(loaded);
  const s = loaded.settings;
  C.assertStateOutsideVault(s.state_dir, vault);
  C.ensureStateDir(s.state_dir);

  let tok;
  try {
    tok = resolveToken({ tokenFile: opts['token-file'], env: process.env, stateDir: s.state_dir });
  } catch (e) {
    if (e.name !== 'TokenError') throw e;
    say(e.message);
    return 1;
  }

  const S = require('./server');
  const H = require('./http');
  const R = S.init(vault, { policyMode: s.policy_page.mode, docs: docsOf(s) });
  warnMissingVault(vault);

  const tokenPage = s.policy_page.mode === 'token';
  let policyPage = null;
  if (tokenPage) {
    const PP = require('./policy-page');
    policyPage = PP.createTokenPage({ vault, allowedHosts: s.allowed_hosts });
  }

  let server, localGuards;
  try {
    ({ server, localGuards } = await H.startHttp({
      port: s.port, host: s.host, token: tok.token, allowedHosts: s.allowed_hosts, logRequests: s.log_requests, legacyToken: tok.legacy,
      maxBodyBytes: require('./body').bodyLimit(s.max_text_bytes), policyPage,
    }));
  } catch (e) {
    say(`cannot listen on ${s.host}:${s.port} (${e.code || e.message})`);
    return 1;
  }

  let page = null;
  if (s.policy_page.mode === 'ha-ingress') {
    const PP = require('./policy-page');
    page = PP.createPolicyPage({ vault, users: s.policy_page.users });
    try {
      await new Promise((resolve, reject) => {
        page.once('error', reject);
        page.listen(s.policy_page.port, () => { page.off('error', reject); resolve(); });
      });
    } catch (e) {
      say(`policy page: cannot listen on port ${s.policy_page.port} (${e.code || e.message})`);
      server.close();
      return 1;
    }
    for (const l of PP.startLines(page.address().port)) process.stderr.write(l + '\n');
  }

  // Trash sweep: off unless a zone opts in. Runs shortly after start and once
  // a day after that.
  require('./retention').start(R.root);

  // One write, so the lines stay together in the log.
  const port = server.address().port;
  const hosts = s.allowed_hosts;
  const hostsSuffix = localGuards && hosts.length ? `, allowed hosts ${hosts.join(', ')}` : '';
  const lines = [`everkeep ${VERSION} on ${s.host}:${port}, vault ${vault}${caseSuffix(vault)}, policies ${s.policy_page.mode}, doclines ${DOCLINES_VERSION}${hostsSuffix}${H.bindNote(localGuards)}`];
  if (tokenPage) lines.push(`everkeep: policy page: ${PAGE_PATH_NOTE}`);
  if (!localGuards && hosts.length)
    lines.push('everkeep: note: allowed_hosts is not used on a non-local bind (there are no Host/Origin checks to relax)');
  if (tok.legacy)
    lines.push(`everkeep: warning: the token from ${tok.source} does not meet the token rules and is accepted only because EVERKEEP_ALLOW_LEGACY_TOKEN=1 inside Home Assistant; clear the token option and restart to get a generated one, then update the connector`);
  if (tok.generated) {
    const [p, b] = connectionLines(tok.token);
    lines.push(
      `everkeep: new token generated and saved to ${tok.file}`,
      `everkeep: claude.ai connector path: ${p}`,
      ...(tokenPage ? [`everkeep: policy page: ${pagePath(tok.token)}`] : []),
      `everkeep: Bearer header: ${b}`,
      'everkeep: shown once; `everkeep token` shows it again');
  }
  process.stderr.write(lines.join('\n') + '\n');

  const stop = () => {
    server.close();
    if (page) page.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return null;
}

// For the start lines: nothing for a case-sensitive vault (the usual case).
function caseSuffix(vault) {
  const SP = require('./safepath');
  const probe = SP.probeCase(vault);
  return probe === 'sensitive' ? '' : `, ${SP.caseNote(probe)}`;
}

// Document settings for server.init (documents.js).
function docsOf(s) {
  return { stateDir: s.state_dir, maxDocBytes: s.max_doc_bytes, maxTextBytes: s.max_text_bytes, extractTimeoutS: s.extract_timeout_s, cacheMaxMb: s.cache_max_mb };
}

function warnMissingVault(vault) {
  let ok = false;
  try { ok = fs.statSync(vault).isDirectory(); } catch {}
  if (!ok) say(`warning: vault ${vault} is not an existing directory; every tool call will fail until it is`);
}

// ---------------------------------------------------------------------------
// stdio (no command)
// ---------------------------------------------------------------------------

async function stdioCommand(args) {
  // The extension passes its "Read-only folders" setting after --readonly:
  // one argument per folder, none when the setting is empty.
  const extension = extensionMode(process.env);
  let readonlyFolders = [];
  const cut = extension ? args.indexOf('--readonly') : -1;
  if (cut >= 0) {
    readonlyFolders = args.slice(cut + 1);
    args = args.slice(0, cut);
  }
  let opts;
  try {
    opts = parseArgs({ args, options: { vault: { type: 'string' } } }).values;
  } catch (e) {
    return usageError(e.message);
  }
  // Nothing but the protocol on stdout: a stray console.log goes to stderr.
  console.log = console.error;
  console.info = console.error;
  const vaultFlag = extension ? extensionVault(opts.vault, { env: process.env, homedir: os.homedir() }) : opts.vault;
  const loaded = load({ vault: vaultFlag });
  const vault = C.requireVault(loaded);
  C.assertStateOutsideVault(loaded.settings.state_dir, vault);
  C.ensureStateDir(loaded.settings.state_dir);
  if (extension) {
    firstRun(vault, { stateDir: loaded.settings.state_dir, homedir: os.homedir() });
    applyReadonlyFolders(vault, readonlyFolders, { stateDir: loaded.settings.state_dir });
  }
  const S = require('./server');
  // No page on stdio: refusals name `everkeep policy`, or the extension
  // settings under Claude Desktop.
  const mode = loaded.settings.policy_page.mode;
  const R = S.init(vault, { policyMode: extension ? 'extension' : mode === 'token' ? 'off' : mode, docs: docsOf(loaded.settings) });
  warnMissingVault(vault);
  require('./retention').start(R.root);
  const { serveStdio } = require('./stdio');
  const { closed } = serveStdio();
  process.stderr.write(`everkeep ${VERSION} on stdio, vault ${vault}${caseSuffix(vault)}, doclines ${DOCLINES_VERSION}\n`);
  closed.then(() => process.exit(0));
  return null;
}

// ---------------------------------------------------------------------------
// token
// ---------------------------------------------------------------------------

function tokenCommand(rest) {
  let opts;
  try {
    opts = parseArgs({ args: rest, options: { new: { type: 'boolean' } } }).values;
  } catch (e) {
    return usageError(e.message);
  }
  const T = require('./token');
  const s = load({}).settings;
  if (opts.new) {
    C.ensureStateDir(s.state_dir);
    const { token, file } = T.replaceToken(s.state_dir);
    process.stdout.write(T.connectionLines(token).join('\n') + '\n');
    say(`new token saved to ${file}; a running server accepts the old token until it is restarted; every connected client must be updated (connector URL or Bearer header)`);
    if (s.policy_page.mode === 'token') say(`policy page: ${pagePath(token)}`);
    if (process.env.EVERKEEP_TOKEN)
      say('warning: env EVERKEEP_TOKEN is set and takes precedence over the saved token; unset it for the new one to take effect');
    return 0;
  }
  let tok;
  try {
    tok = T.resolveToken({ env: process.env, stateDir: s.state_dir, generate: false });
  } catch (e) {
    if (e.name !== 'TokenError') throw e;
    say(e.message);
    return 1;
  }
  process.stdout.write(T.connectionLines(tok.token).join('\n') + '\n');
  if (s.policy_page.mode === 'token') say(`policy page: ${pagePath(tok.token)}`);
  return 0;
}

// ---------------------------------------------------------------------------
// check-config
// ---------------------------------------------------------------------------

// First version number in the tool's -v / -version output, or null when the
// binary cannot be run.
function toolVersion(bin, arg) {
  return new Promise(resolve => {
    execFile(bin, [arg], { timeout: 5000 }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') return resolve(null);
      const m = /(\d+\.\d+(?:\.\d+)?)/.exec(`${stdout || ''}\n${stderr || ''}`);
      resolve(m ? m[1] : (err ? null : '?'));
    });
  });
}

async function checkConfigCommand(rest) {
  let opts;
  try {
    opts = parseArgs({ args: rest, options: { vault: { type: 'string' } } }).values;
  } catch (e) {
    return usageError(e.message);
  }
  const problems = [];
  const out = [`everkeep ${VERSION}`];
  const loaded = load({ vault: opts.vault });
  const s = loaded.settings, src = loaded.sources;
  out.push(`config file: ${loaded.file ? `${loaded.file} (${loaded.fileSource})` : `none (looked in ${loaded.searched.join(', ')})`}`);

  if (!s.vault) {
    problems.push('no vault: run everkeep init once, or pass --vault DIR, set env EVERKEEP_VAULT or "vault" in the config file');
    out.push('vault: none');
  } else {
    let kind = 'missing';
    try { kind = fs.statSync(s.vault).isDirectory() ? 'directory' : 'not a directory'; } catch {}
    if (kind !== 'directory') problems.push(`vault ${s.vault}: ${kind}`);
    out.push(`vault: ${s.vault} (${src.vault}) — ${kind}`);
    if (kind === 'directory') {
      const SP = require('./safepath');
      out.push(`vault case: ${SP.caseNote(SP.probeCase(s.vault))}`);
    }
  }
  out.push(`state dir: ${s.state_dir} (${src.state_dir})`);
  if (s.vault) {
    try { C.assertStateOutsideVault(s.state_dir, s.vault); } catch (e) { problems.push(e.message); }
  }
  out.push(`listen: ${s.host}:${s.port} (host ${src.host}, port ${src.port})`);
  const hosts = s.allowed_hosts;
  out.push(`allowed hosts: ${hosts.length ? hosts.join(', ') : 'none'}` +
    (hosts.length && !require('./http').isLocalBind(s.host) ? ' (not used on a non-local bind)' : ''));
  out.push(`log_requests: ${s.log_requests}`);
  if (s.policy_page.mode === 'token') out.push(`policy page: token (on the MCP port: ${PAGE_PATH_NOTE})`);
  else out.push(`policy page: ${s.policy_page.mode}${s.policy_page.mode === 'ha-ingress' ? ` on port ${s.policy_page.port}, users: ${s.policy_page.users.length ? s.policy_page.users.join(', ') : '(every user)'}` : ''}`);
  out.push(`limits: max_doc_bytes ${s.max_doc_bytes}, max_text_bytes ${s.max_text_bytes}, extract_timeout_s ${s.extract_timeout_s}, cache_max_mb ${s.cache_max_mb}`);

  const T = require('./token');
  try {
    const tok = T.resolveToken({ env: process.env, stateDir: s.state_dir, generate: false });
    out.push(`token: ${tok.source}${tok.legacy ? ' (legacy, accepted inside Home Assistant only)' : ''}`);
  } catch (e) {
    if (e.name !== 'TokenError') throw e;
    if (/^no token yet/.test(e.message)) out.push(`token: none yet (generated on the first \`everkeep serve\`)`);
    else { problems.push(e.message); out.push('token: invalid'); }
  }

  out.push('toolchain:');
  for (const [bin, arg] of [['pdfinfo', '-v'], ['pdftoppm', '-v'], ['sqlite3', '-version']]) {
    const v = await toolVersion(bin, arg);
    if (v === null) problems.push(`${bin} not found on PATH`);
    out.push(`  ${bin}: ${v === null ? 'missing' : v}`);
  }
  out.push(`  doclines: ${DOCLINES_VERSION}`);

  out.push(problems.length ? `\nproblems:\n  ${problems.join('\n  ')}` : '\nok');
  process.stdout.write(out.join('\n') + '\n');
  return problems.length ? 1 : 0;
}

// ---------------------------------------------------------------------------
// policy
// ---------------------------------------------------------------------------

const POLICY_MODES = ['readonly', 'rev', 'free', 'never'];

// `policy set` arguments. DIR comes first: `--trash` takes the next word as the
// trash name when it does not start with "-". Returns { dir, mode, trash,
// trashName, purge } or { error } (a usage error).
function parseSetArgs(args) {
  const o = {};
  const value = (i, flag) => (args[i] === undefined || args[i].startsWith('-') ? { error: `${flag} needs a value` } : { v: args[i] });
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--mode') {
      const r = value(++i, '--mode'); if (r.error) return r; o.mode = r.v;
    } else if (a.startsWith('--mode=')) {
      o.mode = a.slice('--mode='.length);
    } else if (a === '--trash' || a.startsWith('--trash=')) {
      if (o.trash === false) return { error: '--trash and --no-trash exclude each other' };
      o.trash = true;
      if (a.startsWith('--trash=')) o.trashName = a.slice('--trash='.length);
      else if (args[i + 1] !== undefined && !args[i + 1].startsWith('-')) o.trashName = args[++i];
    } else if (a === '--no-trash') {
      if (o.trash === true) return { error: '--trash and --no-trash exclude each other' };
      o.trash = false;
    } else if (a === '--purge-days' || a.startsWith('--purge-days=')) {
      if (o.purge === false) return { error: '--purge-days and --no-purge exclude each other' };
      let v;
      if (a === '--purge-days') { const r = value(++i, '--purge-days'); if (r.error) return r; v = r.v; }
      else v = a.slice('--purge-days='.length);
      if (!/^\d+$/.test(v)) return { error: '--purge-days must be a whole number of days' };
      o.purge = Number(v);
    } else if (a === '--no-purge') {
      if (typeof o.purge === 'number') return { error: '--purge-days and --no-purge exclude each other' };
      o.purge = false;
    } else if (a.startsWith('-')) {
      return { error: `unknown option ${a}` };
    } else if (o.dir === undefined) {
      o.dir = a;
    } else {
      return { error: `unexpected argument "${a}"` };
    }
  }
  if (o.dir === undefined) return { error: 'policy set needs DIR' };
  if (o.mode === undefined) return { error: 'policy set needs --mode' };
  if (!POLICY_MODES.includes(o.mode)) return { error: `--mode must be one of ${POLICY_MODES.join(', ')}` };
  return o;
}

// The change the page would send for these flags: what is not given keeps the
// value in force at DIR, as a save on the page does.
function changeFromFlags(o, policy) {
  return {
    mode: o.mode,
    trash: o.trash !== undefined ? o.trash : !!policy.trash,
    trashName: o.trashName !== undefined ? o.trashName : (policy.trash || require('./policy').DEFAULT_TRASH),
    trashNameGiven: o.trashName !== undefined,
    retention_enabled: o.purge !== undefined ? o.purge !== false : !!policy.retention_enabled,
    retention_days: typeof o.purge === 'number' ? o.purge : (policy.retention_days || 30),
  };
}

// `--vault DIR` / `--vault=DIR` anywhere after the subcommand. Returns
// { vault, args } or { error }.
function takeVault(args) {
  const out = [];
  let vault;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--vault' || a.startsWith('--vault=')) {
      if (vault !== undefined) return { error: '--vault given twice' };
      vault = a === '--vault' ? args[++i] : a.slice('--vault='.length);
      if (vault === undefined || vault === '' || (a === '--vault' && vault.startsWith('-'))) return { error: '--vault needs a value' };
    } else out.push(a);
  }
  return { vault, args: out };
}

function policyCommand(rest) {
  const [sub, ...all] = rest;
  const tv = takeVault(all);
  if (tv.error) return usageError(tv.error);
  const args = tv.args;
  if (!['show', 'set', 'clear'].includes(sub)) return usageError('policy needs show, set or clear');
  let setArgs = null;
  if (sub === 'set') {
    setArgs = parseSetArgs(args);
    if (setArgs.error) return usageError(setArgs.error);
  } else {
    if (args.some(a => a.startsWith('-'))) return usageError(`unknown option ${args.find(a => a.startsWith('-'))}`);
    if (args.length > 1) return usageError(`policy ${sub} takes one DIR`);
    if (sub === 'clear' && args.length === 0) return usageError('policy clear needs DIR');
  }

  const P = require('./policy');
  const SP = require('./safepath');
  const W = require('./policy-write');
  const loaded = load({ vault: tv.vault });
  const vault = C.requireVault(loaded);
  const mode = loaded.settings.policy_page.mode;
  P.setEditorMode(mode);
  const R = SP.createResolver(vault);
  const given = d => (path.isAbsolute(d) ? d : path.join(vault, d));
  const policyLine = dir => {
    const zone = P.policyAt(dir, R.root);
    return P.describePolicy(zone.policy, dir.path, zone.real.path);
  };

  try {
    if (sub === 'show') {
      const dir = R.resolveSafe(given(args[0] === undefined ? vault : args[0]));
      let st;
      try { st = fs.statSync(dir.path); } catch { throw new Error(`${dir.path} does not exist`); }
      if (!st.isDirectory()) throw new Error(`${dir.path} is not a directory`);
      const memo = new Map();
      const zone = P.policyAt(dir, R.root, memo);
      const out = [P.describePolicy(zone.policy, dir.path, zone.real.path), ''];
      const scan = P.findMarkerDirs(zone.real, memo, { policy: zone.policy });
      if (!scan.dirs.length) out.push(`No markers at or below ${zone.real.path}.`);
      else {
        out.push(`Markers at and below ${zone.real.path}:`);
        for (const d of scan.dirs) out.push(P.describePolicy(P.policyForDir(d, R.root, memo), d.path));
      }
      if (scan.truncated) out.push('The scan for markers hit its limit; some may not be listed.');
      process.stdout.write(out.join('\n') + '\n');
      return 0;
    }

    if (sub === 'set') {
      const dir = W.targetDir(R, given(setArgs.dir));
      const change = changeFromFlags(setArgs, P.policyAt(dir, R.root).policy);
      if (setArgs.mode === 'readonly' && setArgs.trash === true) say('note: a read-only zone has no trash; --trash is ignored');
      const spec = W.specOf(change, W.contextOf(R, dir));
      if (typeof setArgs.purge === 'number' && typeof spec.trash !== 'string' && setArgs.mode !== 'readonly')
        say('note: auto-purge belongs to the directory that owns the trash; --purge-days is not written here (give --trash NAME for an own trash)');
      const file = W.writeMarker(R, dir, spec, mode);
      process.stdout.write(`Saved: ${file}\n${policyLine(dir)}\n`);
      return 0;
    }

    // clear: only a regular file is removed.
    const dir = W.targetDir(R, given(args[0]));
    const marker = W.markerPath(dir);
    let st = null;
    try { st = fs.lstatSync(marker.path); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!st) {
      process.stdout.write(`No marker in ${dir.path}; nothing was removed.\n${policyLine(dir)}\n`);
      return 0;
    }
    if (!st.isFile())
      throw new Error(`${marker.path} is not a regular file (a directory or a symlink); nothing was removed — fix it on disk`);
    W.removeMarker(dir);
    process.stdout.write(`Marker removed: ${marker.path} — this directory now follows the rule above it.\n${policyLine(dir)}\n`);
    return 0;
  } catch (e) {
    if (e.name === 'ConfigError') throw e;
    say(e.message);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

const AGENT_QUESTION = 'Which assistant will use this vault? 1) Claude (Claude Code, Claude Desktop, claude.ai)  2) another (Codex, Cursor, …) [1]: ';

// Asks on stderr, reads answers from stdin: empty or 1 → claude, 2 → other;
// after 3 unusable answers, or when stdin ends, claude.
function askAgent() {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => {
    let tries = 0, done = false;
    const finish = agent => { if (done) return; done = true; rl.close(); resolve(agent); };
    rl.on('close', () => finish('claude'));
    const ask = () => rl.question(AGENT_QUESTION, answer => {
      const a = answer.trim();
      if (a === '' || a === '1') return finish('claude');
      if (a === '2') return finish('other');
      if (++tries >= 3) return finish('claude');
      ask();
    });
    ask();
  });
}

const READY_CLAUDE = [
  'Claude Code:',
  '  claude mcp add --scope user --transport stdio everkeep -- npx --yes --package=everkeep everkeep',
  'Claude Desktop (Windows, macOS): the Everkeep extension from https://github.com/st412m/everkeep/releases/latest',
  'claude.ai and other HTTP clients: run `everkeep serve`, then `everkeep token` for the connector path.',
];
const READY_OTHER = [
  'Any MCP client over stdio:',
  '  command: npx   args: --yes --package=everkeep everkeep',
  'HTTP clients: run `everkeep serve`, then `everkeep token` for the connector path.',
];

// Why DIR cannot be a vault that init or the extension's first start sets up,
// or null: the home folder, a filesystem root, or something that is not a
// directory.
function vaultDirProblem(dir, homedir) {
  if (dir === path.resolve(homedir)) return `${dir} is the home folder — give a folder of its own, e.g. ~/everkeep`;
  if (path.parse(dir).root === dir) return `${dir} is a filesystem root — give a folder of its own, e.g. ~/everkeep`;
  let st = null;
  try { st = fs.statSync(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (st && !st.isDirectory()) return `${dir} exists and is not a directory`;
  return null;
}

// Creates DIR when missing, writes the starter instruction file when neither
// CLAUDE.md nor AGENTS.md is at its root, and the root marker (rev, trash on)
// when it has none. Nothing that exists is changed. Reports on stderr.
function setupVault(dir, { agent, editorMode }) {
  const existed = fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  say(`vault: ${dir} (${existed ? 'exists' : 'created'})`);

  const present = p => { try { fs.lstatSync(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
  const name = agent === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';
  const existing = ['CLAUDE.md', 'AGENTS.md'].find(n => present(path.join(dir, n)));
  let wroteInstructions = false;
  if (existing) {
    say(`instruction file: ${existing} exists, left as it is`);
  } else {
    try {
      fs.writeFileSync(path.join(dir, name), require('./starter').STARTER_TEXT, { flag: 'wx' });
      wroteInstructions = true;
      say(`instruction file: ${name} (written)`);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      say(`instruction file: ${name} exists, left as it is`);
    }
  }

  const markerFile = path.join(dir, require('./policy').POLICY_FILE);
  if (present(markerFile)) {
    say(`policy: ${markerFile} exists, left as it is`);
  } else {
    const P = require('./policy');
    const SP = require('./safepath');
    const W = require('./policy-write');
    const R = SP.createResolver(dir);
    P.setEditorMode(editorMode);
    const setArgs = parseSetArgs(['.', '--mode', 'rev', '--trash']);
    const target = W.targetDir(R, dir);
    const change = changeFromFlags(setArgs, P.policyAt(target, R.root).policy);
    W.writeMarker(R, target, W.specOf(change, W.contextOf(R, target)), editorMode);
    say('policy: edits need the current rev, trash on (written)');
  }
  return { wroteInstructions };
}

// Creates a vault with an instruction file and a starter policy and saves it
// as the default vault. Every check runs before anything is created; nothing
// that exists is changed.
async function initCommand(rest, { env = process.env, homedir = os.homedir(), interactive = !!(process.stdin.isTTY && process.stdout.isTTY) } = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: { agent: { type: 'string' } }, allowPositionals: true });
  } catch (e) {
    return usageError(e.message);
  }
  const { values, positionals } = parsed;
  if (positionals.length > 1) return usageError(`unexpected argument "${positionals[1]}"`);
  if (values.agent !== undefined && !['claude', 'other'].includes(values.agent))
    return usageError('--agent must be claude or other');

  const refuse = msg => { say(msg); return 1; };

  if (env.EVERKEEP_CONFIG)
    return refuse(`EVERKEEP_CONFIG is set (${env.EVERKEEP_CONFIG}): add "vault" to that file yourself; init writes only ~/.config/everkeep/config.json`);

  const dir = positionals.length ? path.resolve(positionals[0]) : path.join(homedir, 'everkeep');
  const problem = vaultDirProblem(dir, homedir);
  if (problem) return refuse(problem);

  const cfg = path.join(homedir, '.config', 'everkeep', 'config.json');
  let current = null;
  let saveVault = true;
  if (fs.existsSync(cfg)) {
    try { current = C.readConfigFile(cfg); } catch (e) {
      if (e.name !== 'ConfigError') throw e;
      return refuse(e.message);
    }
    const vault = current && typeof current === 'object' && !Array.isArray(current) ? current.vault : undefined;
    if (typeof vault === 'string') {
      if (path.resolve(vault) !== dir)
        return refuse(`${cfg} already names the vault ${vault}; init does not change it. To use ${dir}, edit that file, or run everkeep with --vault ${dir}`);
      saveVault = false;
    }
  }

  let editorMode;
  try {
    const { settings } = C.loadConfig({ env, homedir, flags: { vault: dir } });
    editorMode = settings.policy_page.mode;
    C.assertStateOutsideVault(settings.state_dir, dir);
  } catch (e) {
    if (e.name !== 'ConfigError') throw e;
    return refuse(e.message);
  }

  const agent = values.agent || (interactive ? await askAgent() : 'claude');

  const { wroteInstructions } = setupVault(dir, { agent, editorMode });

  if (!saveVault) {
    say(`default vault: ${cfg} already names it`);
  } else {
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    const obj = current ? { ...current, vault: dir } : { vault: dir };
    fs.writeFileSync(cfg, JSON.stringify(obj, null, 2) + '\n');
    say(`default vault: saved in ${cfg}`);
  }

  process.stdout.write('\n' + (agent === 'claude' ? READY_CLAUDE : READY_OTHER).join('\n') + '\n');
  if (wroteInstructions)
    say(agent === 'claude' ? 'instruction file for another assistant: everkeep init --agent other' : 'instruction file for Claude: everkeep init --agent claude');
  return 0;
}

// ---------------------------------------------------------------------------
// Claude Desktop extension (.mcpb)
// ---------------------------------------------------------------------------

// The extension's manifest sets EVERKEEP_EXTENSION and passes the Notes folder
// setting as --vault. Claude Desktop starts the server in C:\WINDOWS\system32
// and passes an untouched default ("${HOME}/everkeep") or an empty optional
// setting as the literal placeholder (measured 2026-11-22, Claude Desktop
// 6.28899.6.0 on Windows), so the value is checked here and never resolved
// against the working directory.
const EXTENSION = 'claude-desktop';
const FIRST_RUN_FILE = 'first-run.json';

function extensionMode(env) {
  const v = env.EVERKEEP_EXTENSION;
  if (v === undefined || v === '') return false;
  if (v !== EXTENSION) throw new C.ConfigError(`EVERKEEP_EXTENSION must be "${EXTENSION}" (got "${v}")`);
  return true;
}

// The vault from the extension's --vault value: unfilled → ~/everkeep; a
// leading ${HOME} → the home folder; any other placeholder or a path that is
// not absolute → refused, naming the settings.
function extensionVault(value, { env, homedir }) {
  const where = `set the Notes folder in ${env.EVERKEEP_SETTINGS_UI || 'the extension settings'}`;
  if (value === undefined || value === '' || /^\$\{user_config\.[^}]*\}$/.test(value)) return path.join(homedir, 'everkeep');
  let v = value;
  const home = /^\$\{HOME\}(?=$|[\\/])/.exec(v);
  if (home) v = path.join(homedir, v.slice(home[0].length));
  if (/\$\{[^}]*\}/.test(v)) throw new C.ConfigError(`the Notes folder "${value}" holds a placeholder that was not filled in: ${where}`);
  // On Windows a path without a drive letter or a UNC prefix (\notes) is
  // relative to the current drive.
  const full = process.platform === 'win32' ? /^(?:[A-Za-z]:[\\/]|\\\\)/.test(v) : path.isAbsolute(v);
  if (!full) throw new C.ConfigError(`the Notes folder "${value}" is not a full path: ${where}`);
  return path.resolve(v);
}

// The folders the first start has set up, by real path, from the state dir.
function firstRunFolders(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new C.ConfigError(`${file}: cannot read (${e.code || e.message})`);
  }
  let j;
  try { j = JSON.parse(text); } catch { j = null; }
  if (!j || !Array.isArray(j.folders) || !j.folders.every(f => typeof f === 'string'))
    throw new C.ConfigError(`${file}: not the list of set-up folders everkeep writes; delete it and restart (an existing CLAUDE.md, AGENTS.md or marker is never changed)`);
  return j.folders;
}

// First start in a folder: set it up as init does (agent claude), once. A
// folder already set up is never written to again, so a CLAUDE.md or marker
// the person deleted stays deleted; a set-up folder that is gone is set up
// again.
function firstRun(dir, { stateDir, homedir }) {
  const file = path.join(stateDir, FIRST_RUN_FILE);
  const done = firstRunFolders(file);
  let real = null;
  try { if (fs.statSync(dir).isDirectory()) real = fs.realpathSync.native(dir); } catch {}
  if (real !== null && done.includes(real)) return;
  const problem = vaultDirProblem(dir, homedir);
  if (problem) throw new C.ConfigError(problem);
  say('first start in this folder: setting it up (once)');
  setupVault(dir, { agent: 'claude', editorMode: 'extension' });
  real = fs.realpathSync.native(dir);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ folders: [...done.filter(f => f !== real), real] }, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// The "Read-only folders" setting: a read-only marker in each listed folder
// that has none. The markers the extension wrote are remembered by content in
// the state dir; one whose folder leaves the list is removed if it is still
// the text the extension wrote. A marker the person set (the policies page,
// everkeep policy, by hand), or one changed since, is never touched. A folder
// that cannot hold a marker is skipped with a line on stderr.
const READONLY_FILE = 'readonly-folders.json';

function applyReadonlyFolders(vault, given, { stateDir }) {
  const crypto = require('crypto');
  const P = require('./policy');
  const SP = require('./safepath');
  const W = require('./policy-write');
  const file = path.join(stateDir, READONLY_FILE);
  let all = {};
  try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') throw new C.ConfigError(`${file}: not the record of read-only markers everkeep writes; delete it and restart (markers already on disk stay)`);
  }
  if (!all || typeof all !== 'object' || Array.isArray(all))
    throw new C.ConfigError(`${file}: not the record of read-only markers everkeep writes; delete it and restart (markers already on disk stay)`);
  const root = fs.realpathSync.native(vault);
  const mine = all[root] && typeof all[root] === 'object' ? all[root] : {};
  const R = SP.createResolver(vault);
  P.setEditorMode('extension');
  const hash = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  const markerText = dir => {
    try {
      const m = W.markerPath(dir);
      return fs.lstatSync(m.path).isFile() ? fs.readFileSync(m.path, 'utf8') : null;
    } catch { return null; }
  };

  const wanted = new Map();
  for (const g of given) {
    if (!g || /^\$\{user_config\.[^}]*\}$/.test(g)) continue;
    let dir;
    try { dir = W.targetDir(R, path.resolve(g)); } catch (e) {
      say(`read-only folder ${g} skipped: ${e.message}`);
      continue;
    }
    wanted.set(fs.realpathSync.native(dir.path), dir);
  }

  const next = {};
  for (const [key, h] of Object.entries(mine)) {
    if (wanted.has(key)) continue;
    let dir;
    try { dir = W.targetDir(R, key); } catch { continue; }
    const text = markerText(dir);
    if (text === null) continue;
    if (hash(text) !== h) {
      say(`read-only folder ${key}: its marker was changed after everkeep wrote it; left as it is`);
      continue;
    }
    try {
      W.removeMarker(dir);
      say(`read-only folder ${key}: no longer in the settings, marker removed`);
    } catch (e) {
      say(`read-only folder ${key}: ${e.message}`);
      next[key] = h;
    }
  }
  for (const [key, dir] of wanted) {
    const text = markerText(dir);
    if (text === null) {
      try {
        W.writeMarker(R, dir, W.specOf({ mode: 'readonly' }, W.contextOf(R, dir)), 'extension');
        next[key] = hash(markerText(dir));
        say(`read-only folder ${key}: marker written`);
      } catch (e) {
        say(`read-only folder ${key}: ${e.message}`);
      }
    } else if (mine[key] === hash(text)) {
      next[key] = mine[key];
    } else {
      say(`read-only folder ${key} keeps the marker it has; the setting does not change it`);
    }
  }

  const before = JSON.stringify(mine);
  if (Object.keys(next).length) all[root] = next;
  else delete all[root];
  if (JSON.stringify(all[root] || {}) === before) return;
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === '--version' || cmd === '-v') { process.stdout.write(VERSION + '\n'); return 0; }
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') { process.stdout.write(USAGE); return 0; }

  try {
    if (cmd === undefined || cmd.startsWith('-')) return await stdioCommand(argv);
    if (cmd === 'serve') return await serveCommand(rest);
    if (cmd === 'token') return tokenCommand(rest);
    if (cmd === 'check-config') return await checkConfigCommand(rest);
    if (cmd === 'init') return await initCommand(rest);
    if (cmd === 'policy') return policyCommand(rest);
  } catch (e) {
    if (e.name !== 'ConfigError') throw e;
    say(e.message);
    return 1;
  }
  return usageError(`unknown command "${cmd}"`);
}

// Started as a program: by node itself, or by a host that loads the entry
// point from its own script. Claude Desktop's built-in Node runs extensions
// from its nodeHost.js, so there require.main is that file and argv[1] is this
// one (measured 2026-11-22, Claude Desktop 6.28899.6.0 on Windows).
function startedAsProgram() {
  if (require.main === module) return true;
  try { return !!process.argv[1] && fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(__filename); } catch { return false; }
}

// A command that is done exits once stdout and stderr are flushed. The process
// is not left to end by itself: under Claude Desktop the host's channel keeps
// it alive, and the client waits for an answer that never comes.
function finish(code) {
  process.exitCode = code;
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}

if (startedAsProgram()) {
  main(process.argv.slice(2)).then(
    code => { if (code !== null) finish(code); },
    err => { say(err && err.stack || String(err)); finish(1); },
  );
}

module.exports = { main, USAGE, parseSetArgs, changeFromFlags, initCommand };
