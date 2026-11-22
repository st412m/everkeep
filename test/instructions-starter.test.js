'use strict';
// Server instructions while the instruction file is still the unchanged
// starter of everkeep init: the vault is not set up yet, so the assistant is
// asked to read it before its first reply. Any change counts as set up. A
// process serves one vault, hence a file of its own.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const S = require('../src/server.js');
const { tmpDir } = require('./helpers.js');
const { STARTER_TEXT } = require('../src/starter.js');

const V = tmpDir();
S.init(V);

const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 't', version: '0' },
};
const FRESH = name => `Everkeep: a notes vault. This vault is not set up yet: before your first reply, read ${path.join(V, name)} with read_text_file and follow it.`;
const SET_UP = name => `Everkeep: a notes vault. Before the first vault operation in a session, read ${path.join(V, name)} with read_text_file and follow it.`;

async function initInstructions() {
  const r = await S.handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  return r.result.instructions;
}

async function discoverInstructions() {
  const r = await S.handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'server/discover', params: { _meta: META } });
  return r.result.instructions;
}

test('the unchanged starter as AGENTS.md: not set up yet, in both protocol paths', async () => {
  fs.writeFileSync(path.join(V, 'AGENTS.md'), STARTER_TEXT);
  assert.equal(await initInstructions(), FRESH('AGENTS.md'));
  assert.equal(await discoverInstructions(), FRESH('AGENTS.md'));
});

test('one byte more: set up', async () => {
  fs.appendFileSync(path.join(V, 'AGENTS.md'), 'x');
  assert.equal(await initInstructions(), SET_UP('AGENTS.md'));
  assert.equal(await discoverInstructions(), SET_UP('AGENTS.md'));
});

test('the same text with CRLF line ends (an editor on Windows): set up', async () => {
  fs.writeFileSync(path.join(V, 'AGENTS.md'), STARTER_TEXT.replace(/\n/g, '\r\n'));
  assert.equal(await initInstructions(), SET_UP('AGENTS.md'));
});

test('the starter as CLAUDE.md wins over a changed AGENTS.md; the server changes neither', async () => {
  const agents = fs.readFileSync(path.join(V, 'AGENTS.md'), 'utf8');
  fs.writeFileSync(path.join(V, 'CLAUDE.md'), STARTER_TEXT);
  assert.equal(await initInstructions(), FRESH('CLAUDE.md'));
  assert.equal(await discoverInstructions(), FRESH('CLAUDE.md'));
  assert.equal(fs.readFileSync(path.join(V, 'CLAUDE.md'), 'utf8'), STARTER_TEXT);
  assert.equal(fs.readFileSync(path.join(V, 'AGENTS.md'), 'utf8'), agents);
  assert.deepEqual(fs.readdirSync(V).sort(), ['AGENTS.md', 'CLAUDE.md']);
});
