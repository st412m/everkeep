'use strict';
// Reserved names on a case-sensitive file system (§8): `.vault-policy` and the
// trash name are compared without regard to case on every file system;
// ordinary names keep their case.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const S = require('../src/server.js');
const P = require('../src/policy.js');
const SP = require('../src/safepath.js');
const { tmpDir } = require('./helpers.js');

const V = tmpDir();
const J = (...a) => path.join(V, ...a);
fs.mkdirSync(J('wiki'));
fs.writeFileSync(J('wiki', '.vault-policy'), '{"overwrite":"rev","trash":".vault-trash"}\n');
fs.writeFileSync(J('wiki', 'note.md'), 'needle\n');

// Windows and macOS temp directories ignore case: there this file has nothing
// to check, casefold.test.js covers them.
const insensitive = fs.existsSync(J('WIKI'));
const skip = insensitive ? 'the temp directory ignores case here; this control runs on a case-sensitive file system (Linux)' : false;
S.init(V);

const rev = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);

async function call(name, args) {
  const r = await S.handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return { text: r.result.content.map(c => c.text).join('\n'), isError: r.result.isError === true };
}

test('the case probe tells a case-sensitive vault from an empty one', { skip }, () => {
  assert.equal(SP.probeCase(V), 'sensitive');
  const empty = tmpDir();
  assert.equal(SP.probeCase(empty), 'unknown');
  fs.writeFileSync(path.join(empty, '123'), '');
  assert.equal(SP.probeCase(empty), 'unknown', 'a name without letters cannot be probed');
});

test('samePath on a case-sensitive file system', { skip }, () => {
  fs.writeFileSync(J('wiki', 'Case.md'), 'A\n');
  fs.writeFileSync(J('wiki', 'case.md'), 'b\n');
  assert.equal(SP.samePath(J('wiki', 'case.md'), J('wiki', 'case.md')), true);
  assert.equal(SP.samePath(J('wiki', 'Case.md'), J('wiki', 'case.md')), false, 'two files');
  assert.equal(SP.samePath(J('wiki', 'CASE.md'), J('wiki', 'case.md')), false, 'ENOENT');
  assert.equal(SP.samePath(J('wiki', 'case.md'), J('wiki', 'note.md')), false);
});

test('.VAULT-POLICY and .Vault-Policy are refused as the marker name', { skip }, async () => {
  let r = await call('write_file', { path: J('wiki', '.VAULT-POLICY'), content: '{}' });
  assert.ok(r.isError && r.text.includes('.vault-policy cannot be written through MCP tools'), r.text);
  r = await call('create_directory', { path: J('wiki', '.Vault-Policy') });
  assert.ok(r.isError && r.text.includes('.vault-policy cannot be created through MCP tools'), r.text);
  r = await call('move_file', { source: J('wiki', 'note.md'), destination: J('wiki', '.Vault-Policy'), rev: rev('needle\n') });
  assert.ok(r.isError && r.text.includes('.vault-policy cannot be created through MCP tools'), r.text);
  assert.deepEqual(fs.readdirSync(J('wiki')).filter(n => /vault-policy/i.test(n)), ['.vault-policy']);
});

test('.Vault-Trash is the trash name: moving into it by hand is refused, walks skip it', { skip }, async () => {
  fs.mkdirSync(J('wiki', '.Vault-Trash'));
  fs.writeFileSync(J('wiki', '.Vault-Trash', 'hidden.md'), 'needle-hidden\n');
  let r = await call('move_file', { source: J('wiki', 'note.md'), destination: J('wiki', '.Vault-Trash', 'note.md'), rev: rev('needle\n') });
  assert.ok(r.isError && r.text.includes('do not move things into the trash by hand; use trash_file'), r.text);
  r = await call('grep_files', { path: J('wiki'), pattern: 'needle-hidden' });
  assert.ok(r.text.startsWith('No matches.'), r.text);
  r = await call('read_multiple_files', { paths: [J('wiki', '.Vault-Trash', 'hidden.md')] });
  assert.ok(r.text.includes('bulk reads skip it'), r.text);
  r = await call('search_files', { path: J('wiki'), pattern: 'hidden' });
  assert.equal(r.text, 'No matches\n\n(1 trash directory not searched)');
});

test('a trash name that differs from the marker name only in case is refused', () => {
  for (const t of ['.VAULT-POLICY', '.Vault-Policy'])
    assert.throws(() => P.parseMarker(JSON.stringify({ trash: t })), /"trash" must not be ".vault-policy"/, t);
});

test('ordinary names keep their case: Page.md and page.md are two files', { skip }, async () => {
  let r = await call('write_file', { path: J('wiki', 'Page.md'), content: 'upper\n' });
  assert.ok(!r.isError, r.text);
  r = await call('write_file', { path: J('wiki', 'page.md'), content: 'lower\n' });
  assert.ok(!r.isError && r.text.startsWith('Written: '), r.text);
  assert.equal((await call('read_text_file', { path: J('wiki', 'Page.md') })).text, 'upper\n');
  assert.equal((await call('read_text_file', { path: J('wiki', 'page.md') })).text, 'lower\n');
  r = await call('list_directory', { path: J('wiki') });
  assert.equal(r.text.split('\n')[0], `Policy: overwrite=rev, trash=.vault-trash — own marker (${J('wiki', '.vault-policy')})`);
});
