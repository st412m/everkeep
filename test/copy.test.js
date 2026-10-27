'use strict';
// copy_file: the destination follows the zone rules of write_file.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers.js');

const S = require('../src/server.js');

const V = tmpDir();
const J = (...a) => path.join(V, ...a);
fs.mkdirSync(J('free', 'dir'), { recursive: true });
fs.mkdirSync(J('strict'));
fs.mkdirSync(J('never'));
fs.mkdirSync(J('ro'));
fs.writeFileSync(J('strict', '.vault-policy'), '{"overwrite":"rev","trash":".vault-trash"}\n');
fs.writeFileSync(J('never', '.vault-policy'), '{"overwrite":"never"}\n');
fs.writeFileSync(J('ro', '.vault-policy'), '{"readonly":true}\n');
fs.writeFileSync(J('free', 'a.md'), 'alpha\n');
fs.writeFileSync(J('strict', 'b.md'), 'beta\n');
fs.writeFileSync(J('never', 'c.md'), 'gamma\n');
fs.copyFileSync(path.join(__dirname, 'fixtures', 'documents', 'text.pdf'), J('free', 'doc.pdf'));
S.init(V);

const rev = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);

async function call(args) {
  const r = await S.handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'copy_file', arguments: args } });
  return { text: r.result.content.map(c => c.text).join('\n'), isError: r.result.isError === true };
}

test('a new file: copied, parents created, source kept, rev of the copy', async () => {
  const r = await call({ source: J('free', 'a.md'), destination: J('free', 'new', 'deep', 'a2.md') });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.text, `Copied: ${J('free', 'a.md')} → ${J('free', 'new', 'deep', 'a2.md')} · rev ${rev('alpha\n')}`);
  assert.equal(fs.readFileSync(J('free', 'new', 'deep', 'a2.md'), 'utf8'), 'alpha\n');
  assert.equal(fs.readFileSync(J('free', 'a.md'), 'utf8'), 'alpha\n');
});

test('a binary document is copied byte for byte', async () => {
  const r = await call({ source: J('free', 'doc.pdf'), destination: J('free', 'doc2.pdf') });
  assert.equal(r.isError, false, r.text);
  assert.ok(fs.readFileSync(J('free', 'doc.pdf')).equals(fs.readFileSync(J('free', 'doc2.pdf'))));
});

test('overwrite: free zone yes; rev zone only with the current rev; never zone no', async () => {
  fs.writeFileSync(J('free', 'x.md'), 'old\n');
  let r = await call({ source: J('free', 'a.md'), destination: J('free', 'x.md') });
  assert.equal(r.isError, false, r.text);
  assert.ok(r.text.startsWith('Copied over: '), r.text);

  r = await call({ source: J('free', 'a.md'), destination: J('strict', 'b.md') });
  assert.equal(r.isError, true);
  assert.match(r.text, /requires its current rev, which is /);
  assert.equal(fs.readFileSync(J('strict', 'b.md'), 'utf8'), 'beta\n');
  r = await call({ source: J('free', 'a.md'), destination: J('strict', 'b.md'), rev: rev('beta\n') });
  assert.equal(r.isError, false, r.text);
  assert.equal(fs.readFileSync(J('strict', 'b.md'), 'utf8'), 'alpha\n');

  r = await call({ source: J('free', 'a.md'), destination: J('never', 'c.md') });
  assert.equal(r.isError, true);
  assert.match(r.text, /overwrite: never/);
  assert.equal(fs.readFileSync(J('never', 'c.md'), 'utf8'), 'gamma\n');
  r = await call({ source: J('free', 'a.md'), destination: J('never', 'c-copy.md') });
  assert.equal(r.isError, false, 'a new file in an overwrite=never zone is allowed');
});

test('refused: read-only zone, the trash, a directory, a marker, an existing document, outside the vault', async () => {
  const cases = [
    [{ source: J('free', 'a.md'), destination: J('ro', 'a.md') }, /read-only by policy/],
    [{ source: J('free', 'a.md'), destination: J('strict', '.vault-trash', 'a.md') }, /do not copy things into the trash/],
    [{ source: J('free', 'dir'), destination: J('free', 'dir2') }, /Directories are not copied/],
    [{ source: J('free', 'a.md'), destination: J('free', 'dir') }, /is a directory; give the full path/],
    [{ source: J('strict', '.vault-policy'), destination: J('free', 'p.json') }, /cannot be copied through MCP tools/],
    [{ source: J('free', 'a.md'), destination: J('free', '.vault-policy') }, /cannot be written through MCP tools/],
    [{ source: J('free', 'a.md'), destination: J('free', 'doc.pdf') }, /document formats are not edited/],
    [{ source: J('free', 'a.md'), destination: path.join(path.dirname(V), 'outside.md') }, /PATH_OUTSIDE_VAULT|outside/],
    [{ source: J('free', 'missing.md'), destination: J('free', 'm2.md') }, /ENOENT|no such file/],
  ];
  for (const [args, re] of cases) {
    const r = await call(args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.text, re, r.text);
  }
  assert.ok(!fs.existsSync(J('ro', 'a.md')));
  assert.ok(!fs.existsSync(path.join(path.dirname(V), 'outside.md')));
});
