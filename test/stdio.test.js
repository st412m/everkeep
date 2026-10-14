'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const S = require('../src/server.js');
const { serveStdio } = require('../src/stdio.js');
const { tmpDir, CLI, SKIP_CLI, isolatedEnv } = require('./helpers.js');

const V = tmpDir();
fs.writeFileSync(path.join(V, 'a.md'), 'hello\n');
S.init(V);

// Feeds lines in, collects what comes out, until stdin ends.
async function session(lines) {
  const input = new PassThrough();
  const output = new PassThrough();
  let out = '';
  output.on('data', c => (out += c));
  const { closed } = serveStdio({ input, output });
  for (const l of lines) input.write(l + '\n');
  input.end();
  await closed;
  return out;
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } };

test('initialize, notification, tools/list = 20, tools/call, one JSON line per answer', async () => {
  const out = await session([
    JSON.stringify(INIT),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_text_file', arguments: { path: path.join(V, 'a.md') } } }),
  ]);
  assert.ok(out.endsWith('\n'));
  const msgs = out.trimEnd().split('\n').map(l => JSON.parse(l));
  assert.equal(msgs.length, 3, 'nothing for the notification');
  const byId = Object.fromEntries(msgs.map(m => [m.id, m]));
  assert.equal(byId[1].result.serverInfo.name, 'everkeep');
  assert.equal(byId[1].result.protocolVersion, '2025-06-18');
  assert.equal(byId[2].result.tools.length, 20);
  assert.deepEqual(byId[3].result.content, [{ type: 'text', text: 'hello\n' }]);
});

test('a broken line gets a parse error, a batch one array, blank lines nothing', async () => {
  const out = await session(['{oops', '', JSON.stringify([{ jsonrpc: '2.0', id: 5, method: 'ping' }, { jsonrpc: '2.0', id: 6, method: 'nope' }])]);
  const msgs = out.trimEnd().split('\n').map(l => JSON.parse(l));
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs.find(m => !Array.isArray(m)), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  assert.deepEqual(msgs.find(m => Array.isArray(m)), [{ jsonrpc: '2.0', id: 5, result: {} }, { jsonrpc: '2.0', id: 6, error: { code: -32601, message: 'Method not found: nope' } }]);
});

test('a text with newlines stays on one line', async () => {
  fs.writeFileSync(path.join(V, 'multi.md'), 'one\ntwo\r\nthree\n');
  const out = await session([JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'read_text_file', arguments: { path: path.join(V, 'multi.md') } } })]);
  assert.equal(out.split('\n').length, 2);
  assert.equal(JSON.parse(out).result.content[0].text, 'one\ntwo\r\nthree\n');
});

test('CLI: `everkeep` on stdio prints nothing but protocol on stdout', { skip: SKIP_CLI }, async () => {
  const home = tmpDir();
  const child = spawn(process.execPath, [CLI], { env: isolatedEnv(home, { EVERKEEP_VAULT: V }) });
  let stdout = '', stderr = '';
  child.stdout.on('data', c => (stdout += c));
  child.stderr.on('data', c => (stderr += c));
  child.stdin.write(JSON.stringify(INIT) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'grep_files', arguments: { path: V, pattern: 'hello' } } }) + '\n');
  child.stdin.end();
  const code = await new Promise(r => child.on('exit', r));
  assert.equal(code, 0, stderr);
  const lines = stdout.trimEnd().split('\n');
  assert.equal(lines.length, 3, stdout);
  const msgs = lines.map(l => JSON.parse(l));
  assert.deepEqual(msgs.map(m => m.id).sort(), [1, 2, 3]);
  assert.equal(msgs.find(m => m.id === 2).result.tools.length, 20);
  assert.match(msgs.find(m => m.id === 3).result.content[0].text, /a\.md · rev [0-9a-f]{8} · 1 lines\n {2}1: hello/);
  assert.match(stderr, new RegExp(`^everkeep ${require('../package.json').version.replace(/\./g, '\\.')} on stdio, vault ${V.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, doclines \\d+\\.\\d+\\.\\d+$`, 'm'));
  assert.ok(fs.existsSync(path.join(home, '.local', 'state', 'everkeep')), 'state dir created');
  assert.equal(fs.existsSync(path.join(home, '.local', 'state', 'everkeep', 'token')), false, 'stdio needs no token');
});

test('CLI: stdio without a vault exits 1 with a message on stderr only', { skip: SKIP_CLI }, async () => {
  const home = tmpDir();
  const child = spawn(process.execPath, [CLI], { env: isolatedEnv(home) });
  let stdout = '', stderr = '';
  child.stdout.on('data', c => (stdout += c));
  child.stderr.on('data', c => (stderr += c));
  child.stdin.end();
  assert.equal(await new Promise(r => child.on('exit', r)), 1);
  assert.equal(stdout, '');
  assert.equal(stderr, 'everkeep: no vault: pass --vault DIR, set env EVERKEEP_VAULT or "vault" in the config file\n');
});
