'use strict';
// A vault reached by a UNC path (\\localhost\C$\…, the administrative share):
// reads, writes, the marker refusal and the way out. Runs on Windows where the
// share is reachable (it needs admin rights).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers.js');

const WIN = process.platform === 'win32';
let UNC = null;
let S = null;
let local = null;
if (WIN) {
  local = tmpDir();
  fs.mkdirSync(path.join(local, 'vault', 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(local, 'vault', 'wiki', '.vault-policy'), '{"overwrite":"free","trash":".vault-trash"}\n');
  fs.writeFileSync(path.join(local, 'vault', 'wiki', 'note.md'), 'note\n');
  fs.mkdirSync(path.join(local, 'outside'));
  const m = /^([A-Za-z]):\\(.*)$/.exec(local);
  const candidate = m && `\\\\localhost\\${m[1].toUpperCase()}$\\${m[2]}`;
  try { if (candidate && fs.statSync(path.join(candidate, 'vault')).isDirectory()) UNC = candidate; } catch {}
  if (UNC) {
    S = require('../src/server.js');
    S.init(path.join(UNC, 'vault'));
  }
}
const skip = !WIN ? 'runs on Windows' : UNC ? false : 'the administrative share \\\\localhost\\C$ is not reachable here';
const J = (...a) => path.join(UNC, 'vault', ...a);

async function call(name, args) {
  const r = await S.handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return { text: r.result.content.map(c => c.text).join('\n'), isError: r.result.isError === true };
}

test('UNC vault: read, write, list', { skip }, async t => {
  t.diagnostic(`vault: ${J()}`);
  let r = await call('read_text_file', { path: J('wiki', 'note.md') });
  assert.equal(r.text, 'note\n', r.text);
  r = await call('write_file', { path: J('wiki', 'new.md'), content: 'new\n' });
  assert.equal(r.isError, false, r.text);
  assert.equal(fs.readFileSync(path.join(local, 'vault', 'wiki', 'new.md'), 'utf8'), 'new\n');
  r = await call('list_directory', { path: J('wiki') });
  assert.match(r.text, /\[FILE\] note\.md/);
});

test('UNC vault: the marker is refused, the way out is refused', { skip }, async () => {
  let r = await call('write_file', { path: J('wiki', '.vault-policy'), content: '{}' });
  assert.ok(r.isError && r.text.includes('.vault-policy cannot be written through MCP tools'), r.text);
  r = await call('write_file', { path: path.join(UNC, 'outside', 'x.md'), content: 'x' });
  assert.ok(r.isError && /PATH_OUTSIDE_VAULT/.test(r.text), r.text);
  r = await call('read_text_file', { path: J('..', 'outside') });
  assert.ok(r.isError && /PATH_OUTSIDE_VAULT/.test(r.text), r.text);
  assert.deepEqual(fs.readdirSync(path.join(local, 'outside')), []);
});
