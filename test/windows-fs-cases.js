'use strict';
// Windows file system cases on the folder under `base`: a junction leading out
// of the vault, NTFS file ids, and the 8.3 short name of a marker. The junction
// case runs wherever a junction (a directory symlink off Windows) can be made.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const WIN = process.platform === 'win32';
const MARKER = '{"overwrite":"rev","trash":".vault-trash"}\n';
const rev = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);

// The 8.3 short form of an existing path, or null when the volume has none.
function shortPath(p, folder) {
  const what = folder ? 'GetFolder' : 'GetFile';
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(New-Object -ComObject Scripting.FileSystemObject).${what}($env:EK_PATH).ShortPath`],
  { env: { ...process.env, EK_PATH: p }, encoding: 'utf8' }).trim();
  return out && out.toLowerCase() !== p.toLowerCase() ? out : null;
}

module.exports = function windowsFsCases(base, skip) {
  let S, B, V, OUT;
  const J = (...a) => path.join(V, ...a);
  let junction = false;

  if (!skip) {
    S = require('../src/server.js');
    B = fs.realpathSync.native(fs.mkdtempSync(path.join(base, 'everkeep-winfs-')));
    test.after(() => fs.rmSync(B, { recursive: true, force: true }));
    V = path.join(B, 'vault');
    OUT = path.join(B, 'outside');
    fs.mkdirSync(path.join(V, 'wiki'), { recursive: true });
    fs.mkdirSync(OUT);
    fs.writeFileSync(path.join(OUT, 'secret.md'), 'secret\n');
    fs.writeFileSync(J('wiki', '.vault-policy'), MARKER);
    fs.writeFileSync(J('wiki', 'note.md'), 'note\n');
    try { fs.symlinkSync(OUT, J('wiki', 'jn'), 'junction'); junction = true; } catch {}
    S.init(V);
  }

  async function call(name, args) {
    const r = await S.handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    return { text: r.result.content.map(c => c.text).join('\n'), isError: r.result.isError === true };
  }

  test('a junction leading out of the vault: reads and writes through it are refused', { skip: skip || (junction ? false : 'a junction could not be created here') }, async () => {
    let r = await call('read_text_file', { path: J('wiki', 'jn', 'secret.md') });
    assert.ok(r.isError && /PATH_OUTSIDE_VAULT: .*symlink resolves outside the vault/.test(r.text), r.text);
    r = await call('write_file', { path: J('wiki', 'jn', 'new.md'), content: 'x' });
    assert.ok(r.isError && /PATH_OUTSIDE_VAULT/.test(r.text), r.text);
    assert.deepEqual(fs.readdirSync(OUT), ['secret.md']);
  });

  test('NTFS file ids: distinct files differ, one file under another case is the same', { skip: skip || (WIN ? false : 'runs on Windows') }, () => {
    const a = fs.lstatSync(J('wiki', 'note.md'), { bigint: true });
    const b = fs.lstatSync(J('wiki', '.vault-policy'), { bigint: true });
    const c = fs.lstatSync(J('WIKI', 'NOTE.MD'), { bigint: true });
    assert.notEqual(a.ino, 0n);
    assert.notEqual(a.ino, b.ino);
    assert.equal(a.ino, c.ino);
    assert.equal(a.dev, c.dev);
  });

  test('the 8.3 short name of the marker: every write through it is refused, the marker stays', { skip: skip || (WIN ? false : 'runs on Windows') }, async t => {
    // Only the marker's own short name, under the vault's long path: a short
    // form of a folder above the root is refused as outside the vault anyway.
    const full = shortPath(J('wiki', '.vault-policy'), false);
    const short = full && J('wiki', path.win32.basename(full));
    t.diagnostic(`short name of the marker: ${short || 'none (8.3 names are off on this volume)'}`);
    if (!short) return;
    assert.notEqual(path.basename(short).toLowerCase(), '.vault-policy');
    const results = [];
    for (const [tool, args] of [
      ['write_file', { path: short, content: '{"overwrite":"free"}\n', rev: rev(MARKER) }],
      ['edit_file', { path: short, rev: rev(MARKER), edits: [{ oldText: '"rev"', newText: '"free"' }] }],
      ['trash_file', { path: short, rev: rev(MARKER) }],
      ['move_file', { source: J('wiki', 'note.md'), destination: short }],
      ['copy_file', { source: J('wiki', 'note.md'), destination: short, rev: rev(MARKER) }],
    ]) {
      const r = await call(tool, args);
      results.push(`${tool}: ${r.isError ? 'refused' : 'DONE'} — ${r.text.split('\n')[0]}`);
    }
    for (const line of results) t.diagnostic(line);
    assert.equal(fs.readFileSync(J('wiki', '.vault-policy'), 'utf8'), MARKER, results.join('\n'));
    assert.ok(results.every(l => l.includes(': refused — Error: PATH_WINDOWS_NAME: ') && l.endsWith('an 8.3 short name; use the full name')), results.join('\n'));
  });
};
