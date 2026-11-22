'use strict';
// Server instructions in initialize and server/discover: name CLAUDE.md or
// AGENTS.md at the vault root by its full path when present (more urgent while
// it is the unchanged starter file of everkeep init), a fixed description
// otherwise.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const S = require('../src/server.js');
const { tmpDir } = require('./helpers.js');

const V = tmpDir();
S.init(V);

const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 't', version: '0' },
};
const NONE = 'Everkeep: a notes vault — text files and documents in one folder, read and edited through these tools under write policies.';
const NAMED = name => `Everkeep: a notes vault. Before the first vault operation in a session, read ${path.join(V, name)} with read_text_file and follow it.`;
const AGENTS_TEXT = '# Agents\n\nRead the wiki first.\n';

async function initInstructions() {
  const r = await S.handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  return r.result.instructions;
}

async function discoverInstructions() {
  const r = await S.handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'server/discover', params: { _meta: META } });
  return r.result.instructions;
}

test('empty vault: the fixed description; tools/list has no instructions', async () => {
  assert.equal(await initInstructions(), NONE);
  assert.equal(await discoverInstructions(), NONE);
  const legacy = await S.handleMcpRequest({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.equal(Object.hasOwn(legacy.result, 'instructions'), false);
  const modern = await S.handleMcpRequest({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: { _meta: META } });
  assert.equal(Object.hasOwn(modern.result, 'instructions'), false);
});

test('AGENTS.md present: named', async () => {
  fs.writeFileSync(path.join(V, 'AGENTS.md'), AGENTS_TEXT);
  assert.equal(await initInstructions(), NAMED('AGENTS.md'));
  assert.equal(await discoverInstructions(), NAMED('AGENTS.md'));
});

test('CLAUDE.md wins over AGENTS.md', async () => {
  fs.writeFileSync(path.join(V, 'CLAUDE.md'), '# Claude\n');
  assert.equal(await initInstructions(), NAMED('CLAUDE.md'));
  assert.equal(await discoverInstructions(), NAMED('CLAUDE.md'));
});

test('a directory named CLAUDE.md is skipped', async () => {
  fs.rmSync(path.join(V, 'CLAUDE.md'));
  fs.mkdirSync(path.join(V, 'CLAUDE.md'));
  assert.equal(await initInstructions(), NAMED('AGENTS.md'));
  assert.equal(await discoverInstructions(), NAMED('AGENTS.md'));
});

test('the server wrote nothing to the vault', () => {
  assert.equal(fs.readFileSync(path.join(V, 'AGENTS.md'), 'utf8'), AGENTS_TEXT);
  const entries = fs.readdirSync(V, { withFileTypes: true })
    .map(e => [e.name, e.isFile() ? 'file' : e.isDirectory() ? 'dir' : 'other'])
    .sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(entries, [['AGENTS.md', 'file'], ['CLAUDE.md', 'dir']]);
  assert.deepEqual(fs.readdirSync(path.join(V, 'CLAUDE.md')), []);
});
