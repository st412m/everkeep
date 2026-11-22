'use strict';
// The "Read-only folders" setting of the Claude Desktop extension: the folders
// arrive after --readonly; each gets a read-only marker when it has none; a
// marker the extension wrote goes away when its folder leaves the list; a
// marker the person set, or one changed since, is never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { tmpDir, CLI, isolatedEnv } = require('./helpers.js');

const EXT = { EVERKEEP_EXTENSION: 'claude-desktop', EVERKEEP_SETTINGS_UI: 'the extension settings in Claude Desktop' };
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } };

function start(home, vault, readonly) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, '--vault', vault, '--readonly', ...readonly], { cwd: home, env: isolatedEnv(home, EXT) });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => (stdout += c));
    child.stderr.on('data', c => (stderr += c));
    child.stdin.write(JSON.stringify(INIT) + '\n');
    child.stdin.end();
    child.on('exit', code => resolve({ code, stdout, stderr }));
  });
}

const markerOf = dir => path.join(dir, '.vault-policy');
const readMarker = dir => JSON.parse(fs.readFileSync(markerOf(dir), 'utf8'));

function setup() {
  const home = tmpDir();
  const vault = path.join(home, 'notes');
  for (const d of ['sources', 'archive', 'own']) fs.mkdirSync(path.join(vault, d), { recursive: true });
  return { home, vault, sources: path.join(vault, 'sources'), archive: path.join(vault, 'archive'), own: path.join(vault, 'own') };
}

test('listed folders get a read-only marker naming the extension settings; stdout is the protocol only', async () => {
  const { home, vault, sources, archive } = setup();
  const r = await start(home, vault, [sources, archive]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim().split('\n').length, 1);
  for (const d of [sources, archive]) {
    const m = readMarker(d);
    assert.equal(m.readonly, true);
    assert.equal(m.overwrite, 'never');
    assert.match(m._, /Managed with the Read-only folders setting in the extension settings in Claude Desktop/);
  }
  assert.match(readMarker(vault)._, /Read-only folders setting/, 'the first-start marker names the extension settings too');
  assert.match(r.stderr, /read-only folder .*sources: marker written/);
});

test('an empty setting adds nothing; a folder leaving the list loses the marker the extension wrote', async () => {
  const { home, vault, sources, archive } = setup();
  assert.equal((await start(home, vault, [])).code, 0);
  assert.equal(fs.existsSync(markerOf(sources)), false);
  assert.equal((await start(home, vault, [sources, archive])).code, 0);
  const r = await start(home, vault, [archive]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.existsSync(markerOf(sources)), false);
  assert.equal(readMarker(archive).readonly, true);
  assert.match(r.stderr, /sources: no longer in the settings, marker removed/);
});

test('a marker of the person is neither overwritten nor removed', async () => {
  const { home, vault, own } = setup();
  const mine = JSON.stringify({ readonly: false, overwrite: 'free' }, null, 2) + '\n';
  fs.writeFileSync(markerOf(own), mine);
  const r = await start(home, vault, [own]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(markerOf(own), 'utf8'), mine);
  assert.match(r.stderr, /own keeps the marker it has; the setting does not change it/);
  assert.equal((await start(home, vault, [])).code, 0);
  assert.equal(fs.readFileSync(markerOf(own), 'utf8'), mine);
});

test('a marker the extension wrote and the person changed afterwards stays when the folder leaves the list', async () => {
  const { home, vault, sources } = setup();
  assert.equal((await start(home, vault, [sources])).code, 0);
  const changed = fs.readFileSync(markerOf(sources), 'utf8').replace('"readonly": true', '"readonly": true ');
  fs.writeFileSync(markerOf(sources), changed);
  const r = await start(home, vault, []);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(markerOf(sources), 'utf8'), changed);
  assert.match(r.stderr, /its marker was changed after everkeep wrote it; left as it is/);
});

test('a folder outside the vault or missing is skipped with a line on stderr; the server still starts', async () => {
  const { home, vault } = setup();
  const outside = tmpDir();
  const r = await start(home, vault, [outside, path.join(vault, 'nope'), '${user_config.readonly_folders}']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout.trim()).result.serverInfo.name, 'everkeep');
  assert.match(r.stderr, /read-only folder .* skipped: /);
  assert.equal(fs.existsSync(markerOf(outside)), false);
});

test('without the extension, --readonly is not an option', async () => {
  const home = tmpDir();
  const vault = path.join(home, 'notes');
  fs.mkdirSync(vault);
  const r = await new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, '--vault', vault, '--readonly', vault], { env: isolatedEnv(home) });
    let stderr = '';
    child.stderr.on('data', c => (stderr += c));
    child.stdin.end();
    child.on('exit', code => resolve({ code, stderr }));
  });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--readonly/);
});
