'use strict';
// edit_file {oldText, newText} inserts newText literally: `$&`, `$``, `$'`,
// `$$` and `$1` are not replacement patterns.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const S = require('../src/server.js');
const { tmpDir } = require('./helpers.js');

const V = path.join(tmpDir(), 'vault');
fs.mkdirSync(V);
fs.writeFileSync(path.join(V, '.vault-policy'), '{"overwrite":"free"}\n');
S.init(V);

async function call(name, args) {
  const r = await S.handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return { text: r.result.content.map(c => c.text).join('\n'), isError: r.result.isError === true };
}

test('edit_file oldText/newText: dollar sequences in newText are written as they are', async () => {
  const f = path.join(V, 'dollar.md');
  fs.writeFileSync(f, 'before\nOLD\nafter\n');
  const newText = "a $& b $` c $' d $$ e $1 f $<x> g";
  const r = await call('edit_file', { path: f, edits: [{ oldText: 'OLD', newText }] });
  assert.equal(r.isError, false, r.text);
  assert.equal(fs.readFileSync(f, 'utf8'), `before\n${newText}\nafter\n`);
});

test('edit_file oldText/newText: several edits, each newText literal, only the first match replaced', async () => {
  const f = path.join(V, 'two.md');
  fs.writeFileSync(f, 'x=1\nx=1\ny=2\n');
  const r = await call('edit_file', { path: f, edits: [
    { oldText: 'x=1', newText: 'x=$$' },
    { oldText: 'y=2', newText: "y=$'\\n'" },
  ] });
  assert.equal(r.isError, false, r.text);
  assert.equal(fs.readFileSync(f, 'utf8'), "x=$$\nx=1\ny=$'\\n'\n");
});
