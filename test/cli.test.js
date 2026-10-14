'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { tmpDir, writeJson, CLI, NATIVE, SKIP_CLI, isolatedEnv } = require('./helpers.js');

const VERSION = require('../package.json').version;
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function run(args, env) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 20000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function setup() {
  const base = tmpDir();
  const home = path.join(base, 'home');
  const vault = path.join(base, 'vault');
  fs.mkdirSync(home);
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, 'note.md'), 'hello\n');
  return { base, home, vault, state: path.join(home, '.local', 'state', 'everkeep') };
}

// Starts `everkeep serve` and resolves once the start line is out.
function serve(args, env) {
  const child = spawn(process.execPath, [CLI, 'serve', ...args], { env });
  const st = { child, stdout: '', stderr: '' };
  child.stdout.on('data', c => (st.stdout += c));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no start line: ${st.stderr}`)), 15000);
    child.on('exit', code => { clearTimeout(t); reject(new Error(`exited ${code}: ${st.stderr}`)); });
    child.stderr.on('data', c => {
      st.stderr += c;
      const m = / on [^ ]+:(\d+), vault /.exec(st.stderr);
      if (m && /\n$/.test(st.stderr) && (!/new token generated/.test(st.stderr) || /shown once/.test(st.stderr))) {
        clearTimeout(t);
        st.port = Number(m[1]);
        resolve(st);
      }
    });
  });
}

async function stop(st) {
  st.child.kill('SIGTERM');
  await new Promise(r => (st.child.exitCode !== null ? r() : st.child.once('exit', r)));
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };

function post(port, p, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...headers }, body: JSON.stringify(body),
  });
}

test('--version and --help work everywhere', () => {
  const v = run(['--version'], { PATH: process.env.PATH });
  assert.equal(v.code, 0);
  assert.equal(v.stdout, `${VERSION}\n`);
  const h = run(['--help'], { PATH: process.env.PATH });
  assert.equal(h.code, 0);
  assert.ok(h.stdout.startsWith(`everkeep ${VERSION}\n\nUsage:\n`), h.stdout);
});

test('native Windows / macOS: every command is refused with exit 1', { skip: NATIVE ? 'runs on Windows and macOS' : false }, () => {
  for (const args of [[], ['serve'], ['token'], ['check-config']]) {
    const r = run(args, { PATH: process.env.PATH });
    assert.equal(r.code, 1, args.join(' '));
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^everkeep: (Windows|macOS) is not supported natively \(path checks are Linux-only\); run Everkeep in Docker\n$/);
  }
});

test('usage errors exit 2', { skip: SKIP_CLI }, () => {
  const s = setup();
  const env = isolatedEnv(s.home, { EVERKEEP_VAULT: s.vault });
  for (const args of [['nope'], ['serve', '--bogus'], ['serve', '--port', 'x'], ['serve', '--port', '70000'], ['token', '--bogus'], ['check-config', 'x']]) {
    const r = run(args, env);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.ok(r.stderr.startsWith('everkeep: '), r.stderr);
  }
});

// stdin is written and closed; resolves with the exit code and both streams.
function stdio(args, env, lines) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => (stdout += c));
    child.stderr.on('data', c => (stderr += c));
    child.on('error', reject);
    child.on('exit', code => resolve({ code, stdout, stderr }));
    for (const l of lines) child.stdin.write(JSON.stringify(l) + '\n');
    child.stdin.end();
  });
}

test('stdio with --vault: initialize, tools/list = 20, nothing but protocol on stdout', { skip: SKIP_CLI }, async () => {
  const s = setup();
  const r = await stdio(['--vault', s.vault], isolatedEnv(s.home), [
    INIT,
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_allowed_directories', arguments: {} } },
  ]);
  assert.equal(r.code, 0, r.stderr);
  const msgs = r.stdout.trimEnd().split('\n').map(l => JSON.parse(l));
  assert.equal(msgs.length, 3, r.stdout);
  const byId = Object.fromEntries(msgs.map(m => [m.id, m]));
  assert.equal(byId[1].result.serverInfo.name, 'everkeep');
  assert.equal(byId[2].result.tools.length, 20);
  assert.equal(byId[3].result.content[0].text, `Allowed directories:\n${s.vault}`);
  assert.equal(r.stderr, `everkeep ${VERSION} on stdio, vault ${s.vault}, doclines ${require('doclines/package.json').version}\n`);
});

test('stdio: --vault overrides EVERKEEP_VAULT', { skip: SKIP_CLI }, async () => {
  const s = setup();
  const other = path.join(s.base, 'other');
  fs.mkdirSync(other);
  const call = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_allowed_directories', arguments: {} } };
  let r = await stdio(['--vault', s.vault], isolatedEnv(s.home, { EVERKEEP_VAULT: other }), [call]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).result.content[0].text, `Allowed directories:\n${s.vault}`);
  r = await stdio([], isolatedEnv(s.home, { EVERKEEP_VAULT: other }), [call]);
  assert.equal(JSON.parse(r.stdout).result.content[0].text, `Allowed directories:\n${other}`);
});

test('stdio: any other flag is a usage error, exit 2, nothing on stdout', { skip: SKIP_CLI }, async () => {
  const s = setup();
  const env = isolatedEnv(s.home, { EVERKEEP_VAULT: s.vault });
  for (const args of [['--port', '1'], ['--host', '0.0.0.0'], ['--token-file', 'x'], ['--bogus'], ['--vault', s.vault, '--port', '1'], ['--vault', s.vault, 'extra']]) {
    const r = await stdio(args, env, [INIT]);
    assert.equal(r.code, 2, args.join(' '));
    assert.equal(r.stdout, '', args.join(' '));
    assert.ok(r.stderr.startsWith('everkeep: '), r.stderr);
  }
});

test('serve: no vault, a bad config or a bad token exit 1 and never print the token', { skip: SKIP_CLI }, () => {
  const s = setup();
  let r = run(['serve', '--port', '0'], isolatedEnv(s.home));
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'everkeep: no vault: pass --vault DIR, set env EVERKEEP_VAULT or "vault" in the config file\n');

  const cfg = writeJson(path.join(s.base, 'c.json'), { vault: s.vault, token: 'FAKE' });
  r = run(['serve', '--port', '0'], isolatedEnv(s.home, { EVERKEEP_CONFIG: cfg }));
  assert.equal(r.code, 1);
  assert.equal(r.stderr, `everkeep: ${cfg}: invalid config\n  unknown key "token"\n`);

  r = run(['serve', '--port', '0', '--vault', s.vault], isolatedEnv(s.home, { EVERKEEP_TOKEN: 'FAKE-short-token' }));
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'everkeep: token from env EVERKEEP_TOKEN: the token is too short: 16 chars, at least 32 required; run `everkeep token --new` for a generated one\n');
  assert.equal(fs.existsSync(path.join(s.state, 'token')), false);
});

test('serve: first start generates the token and shows it once; later starts and `check-config` never show it', { skip: SKIP_CLI }, async () => {
  const s = setup();
  const env = isolatedEnv(s.home);
  let st = await serve(['--port', '0', '--vault', s.vault], env);
  let token;
  try {
    const file = path.join(s.state, 'token');
    token = fs.readFileSync(file, 'utf8').trim();
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(s.state).mode & 0o777, 0o700);
    assert.equal(st.stderr,
      `everkeep ${VERSION} on 127.0.0.1:${st.port}, vault ${s.vault}, policies off, doclines ${require('doclines/package.json').version}\n` +
      `everkeep: new token generated and saved to ${file}\n` +
      `everkeep: claude.ai connector path: /private_${token}/mcp\n` +
      `everkeep: Bearer header: Authorization: Bearer ${token}\n` +
      'everkeep: shown once; `everkeep token` shows it again\n');
    assert.equal(st.stdout, '');
    const r = await post(st.port, `/private_${token}/mcp`, INIT);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).result.serverInfo.name, 'everkeep');
  } finally {
    await stop(st);
  }

  st = await serve(['--port', '0', '--vault', s.vault], env);
  try {
    assert.ok(!st.stderr.includes(token), st.stderr);
    assert.equal(fs.readFileSync(path.join(s.state, 'token'), 'utf8').trim(), token, 'reused');
    const r = await post(st.port, '/mcp', INIT, { authorization: `Bearer ${token}` });
    assert.equal(r.status, 200);
  } finally {
    await stop(st);
  }

  const t = run(['token'], env);
  assert.equal(t.code, 0);
  assert.equal(t.stdout, `/private_${token}/mcp\nAuthorization: Bearer ${token}\n`);
  assert.equal(t.stderr, '');

  const c = run(['check-config'], isolatedEnv(s.home, { EVERKEEP_VAULT: s.vault }));
  assert.ok(!c.stdout.includes(token) && !c.stderr.includes(token));
  assert.match(c.stdout, new RegExp(`^token: ${esc(path.join(s.state, 'token'))}$`, 'm'));
});

test('token --new replaces the token and says a running server keeps the old one until restarted', { skip: SKIP_CLI }, () => {
  const s = setup();
  const env = isolatedEnv(s.home);
  let r = run(['token'], env);
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'everkeep: no token yet: `everkeep serve` generates one on its first start, or run `everkeep token --new` for a generated one\n');

  r = run(['token', '--new'], env);
  assert.equal(r.code, 0);
  const [p, b] = r.stdout.trimEnd().split('\n');
  const token = /^\/private_([0-9a-f]{64})\/mcp$/.exec(p)[1];
  assert.equal(b, `Authorization: Bearer ${token}`);
  assert.equal(r.stderr, `everkeep: new token saved to ${path.join(s.state, 'token')}; a running server accepts the old token until it is restarted; every connected client must be updated (connector URL or Bearer header)\n`);

  const again = run(['token', '--new'], env);
  assert.notEqual(again.stdout, r.stdout);
  assert.equal(run(['token'], env).stdout, again.stdout);

  const withEnv = run(['token', '--new'], isolatedEnv(s.home, { EVERKEEP_TOKEN: 'FAKE-env-token-0123456789abcdefghijklm' }));
  assert.match(withEnv.stderr, /warning: env EVERKEEP_TOKEN is set and takes precedence/);
});

test('serve: legacy token only inside Home Assistant, with a warning on every start', { skip: SKIP_CLI }, async () => {
  const s = setup();
  const env = isolatedEnv(s.home, { EVERKEEP_TOKEN: 'changeme', EVERKEEP_ALLOW_LEGACY_TOKEN: '1' });
  const refused = run(['serve', '--port', '0', '--vault', s.vault], env);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /too short/);

  const st = await serve(['--port', '0', '--vault', s.vault], { ...env, SUPERVISOR_TOKEN: 'FAKE-supervisor' });
  try {
    assert.match(st.stderr, /everkeep: warning: the token from env EVERKEEP_TOKEN does not meet the token rules/);
    assert.ok(!st.stderr.includes('changeme'));
    assert.equal((await post(st.port, '/private_changeme/mcp', INIT)).status, 200);
    assert.equal(fs.existsSync(path.join(s.state, 'token')), false);
  } finally {
    await stop(st);
  }
});

test('serve: non-local bind says so on the start line; log_requests masks the token', { skip: SKIP_CLI }, async () => {
  const s = setup();
  const token = 'FAKE-token-for-cli-test-0123456789abcdef';
  const tf = path.join(s.base, 'tok');
  fs.writeFileSync(tf, token + '\n');
  const cfg = writeJson(path.join(s.base, 'c.json'), { vault: s.vault, log_requests: true });
  const st = await serve(['--port', '0', '--host', '0.0.0.0', '--token-file', tf], isolatedEnv(s.home, { EVERKEEP_CONFIG: cfg }));
  try {
    assert.match(st.stderr, /^everkeep \S+ on 0\.0\.0\.0:\d+, vault \S+, policies off, doclines \S+ — non-local bind: no Host\/Origin checks, the token alone protects the server$/m);
    await post(st.port, `/private_${token}/mcp`, INIT);
    await new Promise(r => setTimeout(r, 100));
    assert.match(st.stderr, /^\[req\] \S+ \S+ POST \/private_\*\*\*\/mcp -> 200 \d+B pv=- ua="[^"]*"$/m);
    assert.ok(!st.stderr.includes(token));
    assert.equal(st.stdout, '');
  } finally {
    await stop(st);
  }
});

// A POST with a chosen Host header (fetch does not let a caller set it).
function postWithHost(port, p, body, host) {
  return new Promise((resolve, reject) => {
    const req = require('http').request({ host: '127.0.0.1', port, path: p, method: 'POST',
      headers: { host, 'content-type': 'application/json', accept: 'application/json' } }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('allowed_hosts: start line and check-config show it; a listed Host passes on 127.0.0.1; a non-local bind notes it is unused', { skip: SKIP_CLI }, async () => {
  const s = setup();
  const token = 'FAKE-token-for-allowed-hosts-0123456789';
  const tf = path.join(s.base, 'tok');
  fs.writeFileSync(tf, token + '\n');
  const cfg = writeJson(path.join(s.base, 'c.json'), { vault: s.vault, allowed_hosts: ['notes.example.ts.net', 'notes.example.com'] });
  const env = isolatedEnv(s.home, { EVERKEEP_CONFIG: cfg });
  let st = await serve(['--port', '0', '--token-file', tf], env);
  try {
    assert.match(st.stderr, /^everkeep \S+ on 127\.0\.0\.1:\d+, vault \S+, policies off, doclines \S+, allowed hosts notes\.example\.ts\.net, notes\.example\.com$/m);
    assert.equal(await postWithHost(st.port, `/private_${token}/mcp`, INIT, 'notes.example.ts.net'), 200);
    assert.equal(await postWithHost(st.port, `/private_${token}/mcp`, INIT, 'evil.example.com'), 403);
  } finally {
    await stop(st);
  }
  st = await serve(['--port', '0', '--host', '0.0.0.0', '--token-file', tf], env);
  try {
    assert.match(st.stderr, /^everkeep \S+ on 0\.0\.0\.0:\d+, vault \S+, policies off, doclines \S+ — non-local bind: no Host\/Origin checks, the token alone protects the server$/m);
    assert.match(st.stderr, /^everkeep: note: allowed_hosts is not used on a non-local bind \(there are no Host\/Origin checks to relax\)$/m);
  } finally {
    await stop(st);
  }
  let r = run(['check-config'], env);
  assert.match(r.stdout, /^allowed hosts: notes\.example\.ts\.net, notes\.example\.com$/m);
  const cfg2 = writeJson(path.join(s.base, 'c2.json'), { vault: s.vault, host: '0.0.0.0', allowed_hosts: ['notes.example.ts.net'] });
  r = run(['check-config'], isolatedEnv(s.home, { EVERKEEP_CONFIG: cfg2 }));
  assert.match(r.stdout, /^allowed hosts: notes\.example\.ts\.net \(not used on a non-local bind\)$/m);
  const bad = writeJson(path.join(s.base, 'bad.json'), { vault: s.vault, allowed_hosts: ['https://notes.example.com'] });
  r = run(['check-config'], isolatedEnv(s.home, { EVERKEEP_CONFIG: bad }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /"allowed_hosts": "https:\/\/notes\.example\.com" must be a host name, without a scheme or a path/);
});

test('check-config: resolved settings, toolchain, exit 0/1, no secrets', { skip: SKIP_CLI }, () => {
  const s = setup();
  const token = 'FAKE-token-for-check-config-0123456789ab';
  const r = run(['check-config'], isolatedEnv(s.home, { EVERKEEP_VAULT: s.vault, EVERKEEP_TOKEN: token }));
  assert.ok([0, 1].includes(r.code));
  assert.ok(!r.stdout.includes(token));
  assert.match(r.stdout, new RegExp(`^vault: ${esc(s.vault)} \\(env EVERKEEP_VAULT\\) — directory$`, 'm'));
  assert.match(r.stdout, /^token: env EVERKEEP_TOKEN$/m);
  assert.match(r.stdout, /^listen: 127\.0\.0\.1:3100 \(host default, port default\)$/m);
  assert.match(r.stdout, /^allowed hosts: none$/m);
  assert.match(r.stdout, /^ {2}doclines: \d+\.\d+\.\d+$/m);
  for (const bin of ['pdfinfo', 'pdftoppm', 'sqlite3']) assert.match(r.stdout, new RegExp(`^  ${bin}: (missing|\\d[\\d.]*)$`, 'm'));
  assert.equal(r.code === 0, /\nok\n$/.test(r.stdout));

  const bad = run(['check-config'], isolatedEnv(s.home, { EVERKEEP_VAULT: path.join(s.base, 'missing') }));
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /problems:\n {2}vault \S+missing: missing/);
});

const ROOT_USER = NATIVE && process.getuid && process.getuid() === 0;

test('serve: a state_dir it cannot write says what to do, no stack trace', { skip: SKIP_CLI || (ROOT_USER ? 'root writes everywhere; runs as an ordinary user' : false) }, () => {
  const s = setup();
  const state = path.join(s.base, 'locked-state');
  fs.mkdirSync(state, { mode: 0o500 });
  try {
    const r = run(['serve', '--port', '0', '--vault', s.vault], isolatedEnv(s.home, { EVERKEEP_STATE_DIR: state }));
    assert.equal(r.code, 1);
    const uid = process.getuid();
    assert.equal(r.stderr, `everkeep: state_dir ${state} is not writable by this process (uid ${uid}; the directory belongs to uid ${uid}): make it writable for uid ${uid} (for a Docker volume or bind mount: chown ${uid}:${uid} on it), run as its owner, or set state_dir to another directory\n`);
    const nested = run(['serve', '--port', '0', '--vault', s.vault], isolatedEnv(s.home, { EVERKEEP_STATE_DIR: path.join(state, 'sub') }));
    assert.equal(nested.code, 1);
    assert.match(nested.stderr, /^everkeep: state_dir \S+sub is not writable by this process \(uid \d+\): make it writable/);
  } finally {
    fs.chmodSync(state, 0o700);
  }
});

test('check-config --vault overrides EVERKEEP_VAULT; unknown flags exit 2', { skip: SKIP_CLI }, () => {
  const s = setup();
  const other = path.join(s.base, 'other');
  fs.mkdirSync(other);
  let r = run(['check-config', '--vault', other], isolatedEnv(s.home, { EVERKEEP_VAULT: s.vault }));
  assert.match(r.stdout, new RegExp(`^vault: ${esc(other)} \\(flag --vault\\) — directory$`, 'm'));
  r = run(['check-config', '--vault=' + path.join(s.base, 'missing')], isolatedEnv(s.home, { EVERKEEP_VAULT: s.vault }));
  assert.equal(r.code, 1);
  assert.match(r.stdout, /problems:\n {2}vault \S+missing: missing/);
  for (const args of [['check-config', '--bogus'], ['check-config', '--vault'], ['check-config', 'extra']]) {
    r = run(args, isolatedEnv(s.home, { EVERKEEP_VAULT: s.vault }));
    assert.equal(r.code, 2, args.join(' '));
    assert.equal(r.stdout, '');
  }
});

test('case of the vault: check-config and the start line', { skip: SKIP_CLI }, async () => {
  const s = setup();
  let r = run(['check-config'], isolatedEnv(s.home, { EVERKEEP_VAULT: s.vault }));
  assert.match(r.stdout, /^vault case: case-sensitive vault$/m);

  const empty = path.join(s.base, 'empty');
  fs.mkdirSync(empty);
  r = run(['check-config'], isolatedEnv(s.home, { EVERKEEP_VAULT: empty }));
  assert.match(r.stdout, /^vault case: case sensitivity: unknown \(no entry to probe\)$/m);
  r = await stdio(['--vault', empty], isolatedEnv(s.home), []);
  assert.match(r.stderr, new RegExp(`^everkeep ${esc(VERSION)} on stdio, vault ${esc(empty)}, case sensitivity: unknown \\(no entry to probe\\), doclines `, 'm'));

  const mount = process.env.EVERKEEP_TEST_CI_MOUNT;
  if (!mount) return;
  const ci = fs.mkdtempSync(path.join(mount, 'everkeep-cli-'));
  try {
    fs.writeFileSync(path.join(ci, 'note.md'), 'x\n');
    r = run(['check-config'], isolatedEnv(s.home, { EVERKEEP_VAULT: ci }));
    assert.match(r.stdout, /^vault case: case-insensitive vault$/m);
    const st = await serve(['--port', '0', '--vault', ci], isolatedEnv(s.home));
    try {
      assert.match(st.stderr, new RegExp(`^everkeep ${esc(VERSION)} on 127\\.0\\.0\\.1:\\d+, vault ${esc(ci)}, case-insensitive vault, policies off, doclines `, 'm'));
    } finally {
      await stop(st);
    }
  } finally {
    fs.rmSync(ci, { recursive: true, force: true });
  }
});

test('serve: policy page in ha-ingress mode listens on its own port', { skip: SKIP_CLI }, async () => {
  const s = setup();
  const cfg = writeJson(path.join(s.base, 'c.json'), { vault: s.vault, policy_page: { mode: 'ha-ingress', port: 0, users: ['alice'] } });
  const st = await serve(['--port', '0'], isolatedEnv(s.home, { EVERKEEP_CONFIG: cfg }));
  try {
    assert.match(st.stderr, /^everkeep: policy page on port \d+ \(ingress\), vault /m);
    assert.match(st.stderr, /, policies ha-ingress, /);
    const pagePort = Number(/policy page on port (\d+)/.exec(st.stderr)[1]);
    // Not from the Supervisor's address: refused.
    const r = await fetch(`http://127.0.0.1:${pagePort}/api/tree`);
    assert.equal(r.status, 403);
    assert.equal(await r.text(), 'Forbidden\n');
  } finally {
    await stop(st);
  }
});
