'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const C = require('../src/config.js');
const { tmpDir, writeJson } = require('./helpers.js');

function setup() {
  const base = tmpDir();
  const home = path.join(base, 'home');
  const cwd = path.join(base, 'cwd');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  return { base, home, cwd, userCfg: path.join(home, '.config', 'everkeep', 'config.json') };
}

function errorOf(fn) {
  try { fn(); } catch (e) { return e; }
  assert.fail('expected an error');
}

// ---- lookup ----

test('lookup: env EVERKEEP_CONFIG wins over the user config', () => {
  const s = setup();
  const envCfg = writeJson(path.join(s.base, 'elsewhere.json'), { port: 1111 });
  writeJson(s.userCfg, { port: 2222 });
  const r = C.loadConfig({ env: { EVERKEEP_CONFIG: envCfg }, cwd: s.cwd, homedir: s.home });
  assert.equal(r.file, envCfg);
  assert.equal(r.fileSource, 'env EVERKEEP_CONFIG');
  assert.equal(r.settings.port, 1111);
});

test('lookup: falls back to ~/.config/everkeep/config.json', () => {
  const s = setup();
  writeJson(s.userCfg, { port: 2222 });
  const r = C.loadConfig({ env: {}, cwd: s.cwd, homedir: s.home });
  assert.equal(r.file, s.userCfg);
  assert.equal(r.settings.port, 2222);
});

test('lookup: no file anywhere means flags and env only', () => {
  const s = setup();
  const r = C.loadConfig({ env: {}, cwd: s.cwd, homedir: s.home });
  assert.equal(r.file, null);
  assert.deepEqual(r.searched, [s.userCfg]);
  assert.equal(r.settings.vault, null);
  assert.throws(() => C.requireVault(r), /no vault: pass --vault DIR, set env EVERKEEP_VAULT or "vault" in the config file/);
});

test('lookup: EVERKEEP_CONFIG naming a missing file is an error, not a fallback', () => {
  const s = setup();
  writeJson(s.userCfg, { port: 2222 });
  const missing = path.join(s.base, 'missing.json');
  const e = errorOf(() => C.loadConfig({ env: { EVERKEEP_CONFIG: missing }, cwd: s.cwd, homedir: s.home }));
  assert.equal(e.name, 'ConfigError');
  assert.equal(e.message, `config file from env EVERKEEP_CONFIG not found: ${missing}`);
});

test('a relative EVERKEEP_CONFIG is resolved against the working directory', () => {
  const s = setup();
  writeJson(path.join(s.cwd, 'rel.json'), { port: 3333 });
  assert.equal(C.loadConfig({ env: { EVERKEEP_CONFIG: 'rel.json' }, cwd: s.cwd, homedir: s.home }).settings.port, 3333);
});

// ---- defaults and precedence ----

test('defaults', () => {
  const s = setup();
  const r = C.loadConfig({ env: {}, cwd: s.cwd, homedir: s.home });
  assert.deepEqual(r.settings, {
    vault: null, port: 3100, host: '127.0.0.1', log_requests: false,
    max_doc_bytes: 52428800, max_text_bytes: 20971520, extract_timeout_s: 60, cache_max_mb: 512,
    policy_page: { mode: 'off' }, allowed_hosts: [],
    state_dir: path.join(s.home, '.local', 'state', 'everkeep'),
  });
  assert.equal(r.sources.state_dir, 'default');
});

test('precedence: flags > env > file > defaults', () => {
  const s = setup();
  const vf = path.join(s.base, 'v-file'), ve = path.join(s.base, 'v-env'), vflag = path.join(s.base, 'v-flag');
  const sf = path.join(s.base, 's-file'), se = path.join(s.base, 's-env');
  const cfg = writeJson(path.join(s.base, 'c.json'), { vault: vf, port: 4000, host: '0.0.0.0', state_dir: sf, log_requests: true });

  let r = C.loadConfig({ env: { EVERKEEP_CONFIG: cfg }, cwd: s.cwd, homedir: s.home });
  assert.equal(r.settings.vault, vf);
  assert.equal(r.settings.state_dir, sf);
  assert.equal(r.settings.port, 4000);
  assert.equal(r.settings.log_requests, true);
  assert.equal(r.sources.vault, `config ${cfg}`);

  r = C.loadConfig({ env: { EVERKEEP_CONFIG: cfg, EVERKEEP_VAULT: ve, EVERKEEP_STATE_DIR: se }, cwd: s.cwd, homedir: s.home });
  assert.equal(r.settings.vault, ve);
  assert.equal(r.sources.vault, 'env EVERKEEP_VAULT');
  assert.equal(r.settings.state_dir, se);
  assert.equal(r.sources.state_dir, 'env EVERKEEP_STATE_DIR');

  r = C.loadConfig({ env: { EVERKEEP_CONFIG: cfg, EVERKEEP_VAULT: ve }, cwd: s.cwd, homedir: s.home, flags: { vault: vflag, port: 5000, host: '127.0.0.1' } });
  assert.equal(r.settings.vault, vflag);
  assert.equal(r.sources.vault, 'flag --vault');
  assert.equal(r.settings.port, 5000);
  assert.equal(r.settings.host, '127.0.0.1');
});

test('an empty env variable counts as unset', () => {
  const s = setup();
  const r = C.loadConfig({ env: { EVERKEEP_VAULT: '', EVERKEEP_STATE_DIR: '', EVERKEEP_CONFIG: '' }, cwd: s.cwd, homedir: s.home });
  assert.equal(r.settings.vault, null);
  assert.equal(r.sources.state_dir, 'default');
});

test('policy_page "ha-ingress" gets port 3101 and an empty user list by default', () => {
  const s = setup();
  const cfg = writeJson(path.join(s.base, 'c.json'), { policy_page: { mode: 'ha-ingress' } });
  assert.deepEqual(C.loadConfig({ env: { EVERKEEP_CONFIG: cfg }, cwd: s.cwd, homedir: s.home }).settings.policy_page,
    { mode: 'ha-ingress', port: 3101, users: [] });
});

// ---- validation ----

test('an unknown key is an error, every problem is listed', () => {
  const s = setup();
  const cfg = writeJson(path.join(s.base, 'c.json'), { vault: path.join(s.base, 'v'), token: 'x', colour: 'red', port: 'x' });
  const e = errorOf(() => C.loadConfig({ env: { EVERKEEP_CONFIG: cfg }, cwd: s.cwd, homedir: s.home }));
  assert.equal(e.name, 'ConfigError');
  assert.equal(e.message, `${cfg}: invalid config\n  unknown key "token"\n  unknown key "colour"\n  "port" must be an integer 0-65535`);
});

test('every path in the file is absolute', () => {
  for (const raw of [{ vault: 'relative/vault' }, { state_dir: 'state' }, { vault: 5 }])
    assert.throws(() => C.parseConfig(raw, 'f.json'), /must be an absolute path/, JSON.stringify(raw));
});

test('field checks', () => {
  const bad = [
    [{ log_requests: 'yes' }, /"log_requests" must be true or false/],
    [{ max_doc_bytes: 0 }, /"max_doc_bytes" must be a positive integer/],
    [{ cache_max_mb: 1.5 }, /"cache_max_mb" must be a positive integer/],
    [{ host: '' }, /"host" must be a non-empty string/],
    [{ port: 70000 }, /"port" must be an integer 0-65535/],
    [{ policy_page: { mode: 'web' } }, /"policy_page.mode" must be "off" or "ha-ingress"/],
    [{ policy_page: { mode: 'off', port: 3101 } }, /unknown key "policy_page.port" \(mode "off" takes no other keys\)/],
    [{ policy_page: { mode: 'ha-ingress', users: 'alice' } }, /"policy_page.users" must be an array of strings/],
    [{ policy_page: { mode: 'ha-ingress', login: true } }, /unknown key "policy_page.login"/],
    [{ $comment: 1 }, /"\$comment" must be a string or an array of strings/],
    [[], /must be a JSON object/],
  ];
  for (const [raw, re] of bad) assert.throws(() => C.parseConfig(raw, 'f.json'), re, JSON.stringify(raw));
  assert.doesNotThrow(() => C.parseConfig({ $comment: ['a', 'b'], policy_page: { mode: 'ha-ingress', port: 3101, users: ['alice'] } }, 'f.json'));
});

test('allowed_hosts: host names without scheme, port or path; IPv6 in brackets', () => {
  for (const ok of [[], ['notes.example.ts.net'], ['Notes.Example.COM', '192.0.2.5', '[::1]', '[2001:db8::1]']])
    assert.doesNotThrow(() => C.parseConfig({ allowed_hosts: ok }, 'f.json'), JSON.stringify(ok));
  const bad = [
    ['notes.example.com', /"allowed_hosts" must be an array of host names/],
    [[''], /"allowed_hosts": every entry must be a non-empty string/],
    [[5], /"allowed_hosts": every entry must be a non-empty string/],
    [['https://notes.example.com'], /"allowed_hosts": "https:\/\/notes\.example\.com" must be a host name, without a scheme or a path/],
    [['notes.example.com/mcp'], /must be a host name, without a scheme or a path/],
    [['notes.example.com:443'], /"allowed_hosts": "notes\.example\.com:443" must be a host name without a port \(an IPv6 address goes in brackets\)/],
    [['[::1]:3100'], /must be a host name without a port/],
    [['a b'], /"allowed_hosts": "a b" is not a valid host name/],
    [['user@notes.example.com'], /is not a valid host name/],
    [['[zz]'], /is not a valid host name/],
  ];
  for (const [list, re] of bad) assert.throws(() => C.parseConfig({ allowed_hosts: list }, 'f.json'), re, JSON.stringify(list));
  // Every problem is listed, as for the other keys.
  const e = errorOf(() => C.parseConfig({ allowed_hosts: ['a:1', 'b/c'] }, 'f.json'));
  assert.match(e.message, /"a:1"[\s\S]*"b\/c"/);
});

test('allowed_hosts comes from the config file', () => {
  const s = setup();
  const cfg = writeJson(path.join(s.cwd, 'c.json'), { allowed_hosts: ['notes.example.ts.net'] });
  const r = C.loadConfig({ env: { EVERKEEP_CONFIG: cfg }, cwd: s.cwd, homedir: s.home });
  assert.deepEqual(r.settings.allowed_hosts, ['notes.example.ts.net']);
  assert.equal(r.sources.allowed_hosts, `config ${cfg}`);
});

test('invalid JSON names the file and the position, never the content', () => {
  const s = setup();
  fs.mkdirSync(path.dirname(s.userCfg), { recursive: true });
  fs.writeFileSync(s.userCfg, '{\n  "port": 1,\n  "zzsecretzz" oops\n}');
  const e = errorOf(() => C.loadConfig({ env: {}, cwd: s.cwd, homedir: s.home }));
  assert.match(e.message, /not valid JSON/);
  assert.ok(e.message.startsWith(s.userCfg), e.message);
  assert.ok(!e.message.includes('zzsecretzz'));
});

test('a UTF-8 BOM in the config file is accepted', () => {
  const s = setup();
  fs.mkdirSync(path.dirname(s.userCfg), { recursive: true });
  fs.writeFileSync(s.userCfg, '﻿{"port": 1234}');
  assert.equal(C.loadConfig({ env: {}, cwd: s.cwd, homedir: s.home }).settings.port, 1234);
});

// ---- platform ----

test('native Windows and macOS are refused with a pointer to Docker', () => {
  assert.equal(C.platformRefusal('linux'), null);
  assert.equal(C.platformRefusal('win32'), 'Windows is not supported natively (path checks are Linux-only); run Everkeep in Docker');
  assert.equal(C.platformRefusal('darwin'), 'macOS is not supported natively (path checks are Linux-only); run Everkeep in Docker');
});

test('the state directory is created with mode 0700', { skip: process.platform === 'win32' ? 'POSIX modes' : false }, () => {
  const s = setup();
  const dir = path.join(s.base, 'state', 'deeper');
  C.ensureStateDir(dir);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test('everkeep.example.json is a valid config with every key but state_dir at its default', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'everkeep.example.json'), 'utf8'));
  assert.doesNotThrow(() => C.parseConfig(raw, 'everkeep.example.json'));
  for (const [k, v] of Object.entries(C.DEFAULTS)) assert.deepEqual(raw[k], v, k);
  assert.deepEqual(Object.keys(raw).sort(), ['$comment', 'allowed_hosts', 'cache_max_mb', 'extract_timeout_s', 'host', 'log_requests', 'max_doc_bytes', 'max_text_bytes', 'policy_page', 'port', 'vault']);
});
