'use strict';
// Unicode normalization and letter case in names and in the vault root, on the
// file system under `base`. APFS treats NFC and NFD forms of a name as one
// file; ext4 and NTFS keep them apart. Each case asserts what must hold on
// either kind and reports which kind it ran on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const NFC = s => s.normalize('NFC');
const NFD = s => s.normalize('NFD');

module.exports = function unicodeCases(base, skip) {
  let S, SP, V, B, normInsensitive, caseInsensitive;
  const ROOT = NFC('хранилище-й');
  const TRASH = NFC('удалённое');
  const LOCKED = NFC('заметки-ё');
  const FREE = NFC('папка-й');
  const FILE = NFC('файл-ё.md');
  const J = (...a) => path.join(V, ...a);

  if (!skip) {
    S = require('../src/server.js');
    SP = require('../src/safepath.js');
    B = fs.mkdtempSync(path.join(base, 'everkeep-nfd-'));
    test.after(() => fs.rmSync(B, { recursive: true, force: true }));
    V = path.join(B, ROOT);
    fs.mkdirSync(path.join(V, LOCKED), { recursive: true });
    fs.mkdirSync(path.join(V, FREE));
    fs.writeFileSync(path.join(V, '.vault-policy'), JSON.stringify({ overwrite: 'free', trash: TRASH }) + '\n');
    fs.writeFileSync(path.join(V, LOCKED, '.vault-policy'), '{"readonly":true}\n');
    fs.writeFileSync(path.join(V, 'note.md'), 'note\n');
    fs.writeFileSync(path.join(V, FREE, FILE), 'file\n');
    normInsensitive = fs.existsSync(path.join(V, NFD(LOCKED)));
    caseInsensitive = SP.probeCase(V) === 'insensitive';
    S.init(V);
  }

  async function call(name, args) {
    const r = await S.handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    return { text: r.result.content.map(c => c.text).join('\n'), isError: r.result.isError === true };
  }

  test('the file system under test', { skip }, t => {
    t.diagnostic(`normalization: ${normInsensitive ? 'insensitive' : 'sensitive'}; case: ${caseInsensitive ? 'insensitive' : 'sensitive'}`);
    assert.equal(NFD(LOCKED) === LOCKED, false, 'the test names must have a distinct NFD form');
  });

  test('samePath: NFC and NFD forms are the same path exactly where the file system treats them as one', { skip }, () => {
    assert.equal(SP.samePath(J(LOCKED), J(NFD(LOCKED))), normInsensitive);
  });

  test('a folder named with the NFD form of the trash name is hidden like the trash', { skip }, async () => {
    fs.mkdirSync(J(NFD(TRASH)), { recursive: true });
    fs.writeFileSync(J(NFD(TRASH), 'hidden.md'), 'needle-in-trash\n');
    let r = await call('directory_tree', { path: V });
    assert.equal(r.isError, false, r.text);
    const tree = r.text.split('\n').slice(1).join('\n');
    assert.equal(tree.includes(NFD(TRASH)) || tree.includes(TRASH), false, r.text);
    assert.match(r.text, /1 trash directory omitted/);
    r = await call('grep_files', { path: V, pattern: 'needle-in-trash' });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /— 0 match\(es\)/);
    fs.rmSync(J(NFD(TRASH)), { recursive: true, force: true });
  });

  test('a write through the NFD form of a read-only folder: refused where it is that folder', { skip }, async () => {
    const r = await call('write_file', { path: J(NFD(LOCKED), 'new.md'), content: 'x' });
    if (normInsensitive) {
      assert.ok(r.isError, r.text);
      assert.match(r.text, /read-only/);
      assert.equal(fs.existsSync(J(LOCKED, 'new.md')), false);
    } else {
      assert.equal(r.isError, false, r.text);
      assert.equal(fs.existsSync(J(LOCKED, 'new.md')), false);
    }
  });

  test('trash_file through an all-NFD path', { skip }, async t => {
    const r = await call('trash_file', { path: J(NFD(FREE), NFD(FILE)) });
    if (normInsensitive) {
      assert.equal(r.isError, false, r.text);
      assert.equal(fs.existsSync(J(FREE, FILE)), false);
      const trashed = fs.readdirSync(J(TRASH, FREE));
      assert.equal(trashed.length, 1, trashed.join(', '));
    } else {
      assert.ok(r.isError, r.text);
      assert.equal(fs.existsSync(J(FREE, FILE)), true);
    }
    t.diagnostic(r.text.split('\n')[0]);
  });

  // The root in another spelling is refused everywhere; where it is the same
  // folder, the message names the spelling to use.
  const HINT = ` (the vault is ${V} — spell the path with that prefix)`;

  test('the vault root in NFD: refused; the hint where it is the same folder', { skip }, async t => {
    const p = path.join(B, NFD(ROOT), 'note.md');
    const r = await call('read_text_file', { path: p });
    t.diagnostic(`root in NFD → ${r.text.split('\n')[0]}`);
    assert.equal(r.text, `Error: PATH_OUTSIDE_VAULT: ${p}` + (normInsensitive ? HINT : ''));
  });

  test('the vault root in another letter case: refused; the hint where it is the same folder', { skip }, async t => {
    const p = path.join(B, ROOT.toUpperCase(), 'note.md');
    const r = await call('read_text_file', { path: p });
    t.diagnostic(`root in upper case → ${r.text.split('\n')[0]}`);
    assert.equal(r.text, `Error: PATH_OUTSIDE_VAULT: ${p}` + (caseInsensitive ? HINT : ''));
  });

  test('a sibling sharing the name prefix gets no hint', { skip }, async () => {
    const sib = V + '_old';
    fs.mkdirSync(sib);
    fs.writeFileSync(path.join(sib, 'note.md'), 'old\n');
    const p = path.join(sib, 'note.md');
    const r = await call('read_text_file', { path: p });
    assert.equal(r.text, `Error: PATH_OUTSIDE_VAULT: ${p}`);
  });
};
