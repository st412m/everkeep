'use strict';
// Names Windows refuses or rewrites: refused by resolveSafe on Windows before
// any file system call, and ordinary names on Linux and macOS.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const SP = require('../src/safepath.js');
const S = require('../src/server.js');
const { tmpDir } = require('./helpers.js');

const WIN = process.platform === 'win32';
const V = tmpDir();
fs.writeFileSync(path.join(V, 'note.md'), 'note\n');
S.init(V);

async function call(name, args) {
  const r = await S.handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return { text: r.result.content.map(c => c.text).join('\n'), isError: r.result.isError === true };
}

const REFUSED = [
  ['a.md:hidden', 'a colon names an alternate data stream'],
  ['a.md::$DATA', 'a colon names an alternate data stream'],
  ['CON', 'a reserved device name'],
  ['con.md', 'a reserved device name'],
  ['Nul.tar.gz', 'a reserved device name'],
  ['PRN.txt', 'a reserved device name'],
  ['aux', 'a reserved device name'],
  ['COM1', 'a reserved device name'],
  ['com9.log', 'a reserved device name'],
  ['COM¹.md', 'a reserved device name'],
  ['LPT1', 'a reserved device name'],
  ['lpt³', 'a reserved device name'],
  ['a.md.', 'Windows drops a trailing space or period'],
  ['a.md ', 'Windows drops a trailing space or period'],
  ['dir.', 'Windows drops a trailing space or period'],
  // Win32 would open the marker or the trash under these names.
  ['.vault-policy.', 'Windows drops a trailing space or period'],
  ['.VAULT-POLICY ', 'Windows drops a trailing space or period'],
  ['.vault-trash.', 'Windows drops a trailing space or period'],
];
const ALLOWED = ['.temp', 'console.md', 'COM10.md', 'LPT0.md', 'nul2.txt', 'a.b.c', 'CONFIG', 'auxiliary.md'];

test('windowsNameProblem: refused names and their reasons', () => {
  for (const [name, why] of REFUSED) assert.equal(SP.windowsNameProblem(name), why, name);
  for (const name of ALLOWED) assert.equal(SP.windowsNameProblem(name), null, name);
});

test('a resolver in Windows mode refuses those names in any segment, and the two prefixes', () => {
  const R = SP.createResolver(V, { windows: true });
  for (const [name, why] of REFUSED) {
    for (const p of [path.join(V, name), path.join(V, name, 'x.md'), path.join(V, 'sub', name)]) {
      assert.throws(() => R.resolveSafe(p), e => e.message === `PATH_WINDOWS_NAME: ${p} — "${name}": ${why}`, p);
    }
  }
  for (const p of ['\\\\?\\C:\\vault\\a.md', '\\\\.\\COM1', '//?/C:/vault/a.md', '//./PhysicalDrive0']) {
    assert.throws(() => R.resolveSafe(p), e => e.message === `PATH_WINDOWS_NAME: ${p} — the \\\\?\\ and \\\\.\\ prefixes are not accepted`, p);
  }
  for (const name of ALLOWED) assert.equal(R.resolveSafe(path.join(V, name)).path, path.join(V, name));
});

test('a resolver not in Windows mode leaves those names alone', { skip: WIN ? 'on Windows the file system itself treats these names specially' : false }, () => {
  const R = SP.createResolver(V, { windows: false });
  for (const [name] of REFUSED) assert.equal(R.resolveSafe(path.join(V, name)).path, path.join(V, name));
});

test('on Windows the tools refuse them; nothing is written', { skip: WIN ? false : 'runs on Windows' }, async () => {
  for (const name of ['NUL.md', 'a.md:hidden', 'b.md.', '.vault-policy.']) {
    const r = await call('write_file', { path: path.join(V, name), content: 'x' });
    assert.ok(r.isError, r.text);
    assert.match(r.text, /^Error: PATH_WINDOWS_NAME: /, r.text);
  }
  const r = await call('read_text_file', { path: path.join(V, 'note.md:stream') });
  assert.match(r.text, /^Error: PATH_WINDOWS_NAME: /, r.text);
  assert.deepEqual(fs.readdirSync(V).sort(), ['note.md']);
});

test('on Linux and macOS they are ordinary file names', { skip: WIN ? 'Windows refuses them' : false }, async () => {
  for (const name of ['CON.md', 'a.md:colon', 'b.md.']) {
    const r = await call('write_file', { path: path.join(V, name), content: name });
    assert.equal(r.isError, false, r.text);
    assert.equal(fs.readFileSync(path.join(V, name), 'utf8'), name);
  }
});
