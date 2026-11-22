'use strict';
// The Claude Desktop extension (.mcpb): the Notes folder setting arrives as
// --vault, untouched defaults and empty settings as literal placeholders, the
// working directory is not the user's. The first start sets a folder up as
// init does, once; stdout carries nothing but the protocol.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { STARTER_TEXT } = require('../src/starter.js');
const { tmpDir, CLI, isolatedEnv } = require('./helpers.js');

const UI = 'the extension settings in Claude Desktop';
const EXT = { EVERKEEP_EXTENSION: 'claude-desktop', EVERKEEP_SETTINGS_UI: UI };
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } };

// Starts the stdio server as the extension would, sends initialize, ends stdin.
// cwd stands for C:\WINDOWS\system32: a folder that must stay untouched.
function start(home, args, extraEnv = EXT) {
  const cwd = path.join(home, 'cwd');
  fs.mkdirSync(cwd, { recursive: true });
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: isolatedEnv(home, extraEnv) });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => (stdout += c));
    child.stderr.on('data', c => (stderr += c));
    child.stdin.write(JSON.stringify(INIT) + '\n');
    child.stdin.end();
    child.on('exit', code => resolve({ code, stdout, stderr, cwdEntries: fs.readdirSync(cwd) }));
  });
}

const read = p => fs.readFileSync(p);
const marker = dir => JSON.parse(fs.readFileSync(path.join(dir, '.vault-policy'), 'utf8'));
const record = home => JSON.parse(fs.readFileSync(path.join(home, '.local', 'state', 'everkeep', 'first-run.json'), 'utf8'));

function protocolOnly(r) {
  const lines = r.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 1, r.stdout);
  assert.equal(JSON.parse(lines[0]).result.serverInfo.name, 'everkeep');
}

test('untouched default ${HOME}/everkeep: ~/everkeep set up with CLAUDE.md and a rev marker, recorded', async () => {
  const home = tmpDir();
  const r = await start(home, ['--vault', '${HOME}/everkeep']);
  assert.equal(r.code, 0, r.stderr);
  protocolOnly(r);
  const vault = path.join(home, 'everkeep');
  assert.ok(read(path.join(vault, 'CLAUDE.md')).equals(Buffer.from(STARTER_TEXT, 'utf8')));
  assert.equal(marker(vault).overwrite, 'rev');
  assert.equal(typeof marker(vault).trash, 'string');
  assert.deepEqual(record(home), { folders: [fs.realpathSync.native(vault)] });
  assert.match(r.stderr, /^everkeep: first start in this folder: setting it up \(once\)$/m);
  assert.deepEqual(r.cwdEntries, []);
  assert.equal(fs.existsSync(path.join(home, '.config', 'everkeep', 'config.json')), false, 'no config file');
});

test('an unfilled ${user_config.vault} and a missing --vault: ~/everkeep', async () => {
  for (const args of [['--vault', '${user_config.vault}'], []]) {
    const home = tmpDir();
    const r = await start(home, args);
    assert.equal(r.code, 0, r.stderr);
    protocolOnly(r);
    assert.ok(fs.existsSync(path.join(home, 'everkeep', 'CLAUDE.md')));
  }
});

test('a relative path or another placeholder: refused, naming the settings; nothing created', async () => {
  for (const v of ['notes', '${DOCUMENTS}/notes', '${HOME}x']) {
    const home = tmpDir();
    const r = await start(home, ['--vault', v]);
    assert.equal(r.code, 1, v);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, new RegExp(`set the Notes folder in ${UI}`));
    assert.deepEqual(r.cwdEntries, [], v);
    assert.equal(fs.existsSync(path.join(home, 'everkeep')), false);
  }
});

test('the home folder: refused, nothing written', async () => {
  // The default state dir is inside the home folder, so that check refuses
  // first; with the state dir elsewhere the home-folder check does.
  const home = tmpDir();
  const r = await start(home, ['--vault', '${HOME}']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /is inside the vault/);
  const elsewhere = tmpDir();
  const s = await start(home, ['--vault', '${HOME}'], { ...EXT, EVERKEEP_STATE_DIR: elsewhere });
  assert.equal(s.code, 1);
  assert.match(s.stderr, /is the home folder — give a folder of its own/);
  assert.equal(fs.existsSync(path.join(home, 'CLAUDE.md')), false);
  assert.equal(fs.existsSync(path.join(home, '.vault-policy')), false);
});

test('a chosen folder with files but no instruction file: CLAUDE.md and marker added, the files untouched', async () => {
  const home = tmpDir();
  const vault = path.join(home, 'notes');
  fs.mkdirSync(path.join(vault, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'sub', 'a.md'), 'mine\n');
  const r = await start(home, ['--vault', vault]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(read(path.join(vault, 'CLAUDE.md')).equals(Buffer.from(STARTER_TEXT, 'utf8')));
  assert.equal(marker(vault).overwrite, 'rev');
  assert.equal(fs.readFileSync(path.join(vault, 'sub', 'a.md'), 'utf8'), 'mine\n');
});

test('an own AGENTS.md and an own marker: both byte-identical, no CLAUDE.md', async () => {
  const home = tmpDir();
  const vault = path.join(home, 'notes');
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, 'AGENTS.md'), '# my rules\n');
  const own = JSON.stringify({ readonly: false, overwrite: 'free' }, null, 2) + '\n';
  fs.writeFileSync(path.join(vault, '.vault-policy'), own);
  const r = await start(home, ['--vault', vault]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(vault, 'AGENTS.md'), 'utf8'), '# my rules\n');
  assert.equal(fs.readFileSync(path.join(vault, '.vault-policy'), 'utf8'), own);
  assert.equal(fs.existsSync(path.join(vault, 'CLAUDE.md')), false);
});

test('once per folder: a deleted CLAUDE.md and marker stay deleted on the next start', async () => {
  const home = tmpDir();
  const vault = path.join(home, 'everkeep');
  assert.equal((await start(home, [])).code, 0);
  fs.rmSync(path.join(vault, 'CLAUDE.md'));
  fs.rmSync(path.join(vault, '.vault-policy'));
  const r = await start(home, []);
  assert.equal(r.code, 0, r.stderr);
  protocolOnly(r);
  assert.equal(fs.existsSync(path.join(vault, 'CLAUDE.md')), false);
  assert.equal(fs.existsSync(path.join(vault, '.vault-policy')), false);
  assert.doesNotMatch(r.stderr, /first start/);
});

test('a set-up folder that is gone is set up again; two folders are both recorded', async () => {
  const home = tmpDir();
  const a = path.join(home, 'everkeep');
  const b = path.join(home, 'other');
  assert.equal((await start(home, [])).code, 0);
  assert.equal((await start(home, ['--vault', b])).code, 0);
  fs.rmSync(a, { recursive: true });
  const r = await start(home, []);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(a, 'CLAUDE.md')));
  assert.deepEqual(record(home).folders.sort(), [fs.realpathSync.native(a), fs.realpathSync.native(b)].sort());
});

test('a damaged first-run record: refused with its path, nothing written', async () => {
  const home = tmpDir();
  const state = path.join(home, '.local', 'state', 'everkeep');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'first-run.json'), '{oops');
  const r = await start(home, []);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /first-run\.json: not the list of set-up folders/);
  assert.equal(fs.existsSync(path.join(home, 'everkeep')), false);
});

test('EVERKEEP_EXTENSION with another value: refused', async () => {
  const home = tmpDir();
  const r = await start(home, [], { EVERKEEP_EXTENSION: 'yes' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /EVERKEEP_EXTENSION must be "claude-desktop"/);
});

test('without the extension: a placeholder vault is refused; a plain vault is never written to', async () => {
  const home = tmpDir();
  const r = await start(home, ['--vault', '${HOME}/everkeep'], {});
  assert.equal(r.code, 1);
  assert.match(r.stderr, /holds a \$\{\.\.\.\} placeholder that was not filled in/);
  assert.deepEqual(r.cwdEntries, []);
  const vault = path.join(home, 'plain');
  fs.mkdirSync(vault);
  const p = await start(home, ['--vault', vault], {});
  assert.equal(p.code, 0, p.stderr);
  protocolOnly(p);
  assert.deepEqual(fs.readdirSync(vault), []);
});
