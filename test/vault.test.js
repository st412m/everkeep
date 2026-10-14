'use strict';
// An ordinary read and write in a zone, and the ways out of the vault that the
// 2.8.0 acceptance tried: `..`, a sibling sharing the name prefix, a symlink
// out, and a module called directly with a path that did not come from
// resolveSafe().
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const S = require('../src/server.js');
const P = require('../src/policy.js');
const SP = require('../src/safepath.js');
const SQLITE = require('../src/sqlite.js');
const { tmpDir } = require('./helpers.js');

const POSIX = process.platform === 'win32' ? 'symlinks need a POSIX filesystem; they run on Linux' : false;

const base = tmpDir();
const V = path.join(base, 'vault');
const J = (...a) => path.join(V, ...a);
fs.mkdirSync(J('wiki'), { recursive: true });
fs.writeFileSync(J('wiki', '.vault-policy'), '{"overwrite":"rev","trash":".vault-trash"}\n');
fs.writeFileSync(J('wiki', 'page.md'), 'line one\nline two\n');
fs.mkdirSync(V + '_backup');
fs.writeFileSync(path.join(V + '_backup', 'secret.txt'), 'outside\n');
fs.mkdirSync(path.join(base, 'outside'));
fs.writeFileSync(path.join(base, 'outside', 'secret.txt'), 'outside\n');
if (!POSIX) fs.symlinkSync(path.join(base, 'outside'), J('wiki', 'out-link'), 'dir');
const R = S.init(V);

async function call(name, args) {
  const r = await S.handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return { text: r.result.content.map(c => c.text).join('\n'), isError: r.result.isError === true };
}

test('read and write in a rev zone: create, refuse without rev, overwrite with rev', async () => {
  let r = await call('list_directory', { path: J('wiki') });
  assert.ok(r.text.startsWith(`Policy: overwrite=rev, trash=.vault-trash — own marker (${J('wiki', '.vault-policy')})`), r.text);

  r = await call('write_file', { path: J('wiki', 'new.md'), content: 'fresh\n' });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /^Written: .*new\.md · rev [0-9a-f]{8}$/);

  r = await call('read_text_file', { path: J('wiki', 'page.md'), offset: 1 });
  const rev = /· rev ([0-9a-f]{8}) ·/.exec(r.text)[1];

  r = await call('write_file', { path: J('wiki', 'page.md'), content: 'changed\n' });
  assert.ok(r.isError);
  assert.match(r.text, new RegExp(`requires its current rev, which is ${rev}\\. Nothing was written`));
  assert.equal(fs.readFileSync(J('wiki', 'page.md'), 'utf8'), 'line one\nline two\n');

  r = await call('edit_file', { path: J('wiki', 'page.md'), rev, edits: [{ startLine: 2, endLine: 2, newText: 'line 2' }] });
  assert.ok(!r.isError, r.text);
  assert.equal(fs.readFileSync(J('wiki', 'page.md'), 'utf8'), 'line one\nline 2\n');

  r = await call('write_file', { path: J('wiki', '.vault-policy'), content: '{}' });
  assert.ok(r.isError && r.text.includes('.vault-policy cannot be written through MCP tools'), r.text);
});

test('the marker name as a directory anywhere in the path is refused; nothing appears on disk', async () => {
  fs.mkdirSync(J('wiki', 'sub'), { recursive: true });
  fs.writeFileSync(J('wiki', 'sub', 'page.md'), 'sub page\n');
  const subPolicy = (await call('list_directory', { path: J('wiki', 'sub') })).text.split('\n')[0];
  const wikiPolicy = (await call('list_directory', { path: J('wiki') })).text.split('\n')[0];
  // wiki has its own marker file; wiki/sub inherits it and has none.
  for (const zone of ['sub', '']) {
    const Z = (...a) => J('wiki', zone, ...a);
    const cases = [
      ['write_file', { path: Z('.vault-policy', 'x.md'), content: 'x' }, 'written'],
      ['write_file', { path: Z('.VAULT-POLICY', 'x.md'), content: 'x' }, 'written'],
      ['write_file', { path: Z('.vault-policy', 'deeper', 'x.md'), content: 'x' }, 'written'],
      ['create_directory', { path: Z('.vault-policy', 'sub') }, 'created'],
      ['move_file', { source: Z('page.md'), destination: Z('.vault-policy', 'page.md') }, 'created'],
    ];
    for (const [tool, args, verb] of cases) {
      const r = await call(tool, args);
      assert.ok(r.isError, `${zone} ${tool} ${JSON.stringify(args)}: ${r.text}`);
      // Where the marker file itself is on the way, Linux stops the path
      // earlier (realpath: ENOTDIR); the zone without a marker of its own is
      // the case that used to create the directory.
      const ok = r.text.startsWith(`Error: .vault-policy cannot be ${verb} through MCP tools`) ||
        (zone === '' && r.text.startsWith('Error: ENOTDIR: not a directory'));
      assert.ok(ok, `${zone} ${tool}: ${r.text}`);
    }
  }
  assert.deepEqual(fs.readdirSync(J('wiki', 'sub')).sort(), ['page.md']);
  assert.equal(fs.statSync(J('wiki', '.vault-policy')).isFile(), true);
  assert.equal((await call('list_directory', { path: J('wiki', 'sub') })).text.split('\n')[0], subPolicy);
  assert.equal((await call('list_directory', { path: J('wiki') })).text.split('\n')[0], wikiPolicy);
  const r = await call('write_file', { path: J('wiki', 'sub', 'fresh.md'), content: 'fresh\n' });
  assert.ok(!r.isError && r.text.startsWith('Written: '), r.text);
});

test('`..` and a sibling sharing the name prefix are outside the vault', async () => {
  for (const p of [J('..', 'outside', 'secret.txt'), path.join(V + '_backup', 'secret.txt'), J('wiki', '..', '..', 'vault_backup', 'secret.txt')]) {
    for (const [tool, args] of [['read_text_file', { path: p }], ['write_file', { path: p, content: 'x' }], ['get_file_info', { path: p }]]) {
      const r = await call(tool, args);
      assert.ok(r.isError, `${tool} ${p}`);
      assert.match(r.text, /^Error: PATH_OUTSIDE_VAULT: /, r.text);
    }
  }
  assert.equal(fs.readFileSync(path.join(V + '_backup', 'secret.txt'), 'utf8'), 'outside\n');
});

test('a symlink out of the vault is refused for reads and writes', { skip: POSIX }, async () => {
  for (const [tool, args] of [
    ['read_text_file', { path: J('wiki', 'out-link', 'secret.txt') }],
    ['write_file', { path: J('wiki', 'out-link', 'new.txt'), content: 'x' }],
    ['list_directory', { path: J('wiki', 'out-link') }],
    ['grep_files', { path: J('wiki', 'out-link'), pattern: 'outside' }],
  ]) {
    const r = await call(tool, args);
    assert.ok(r.isError, tool);
    assert.match(r.text, /PATH_OUTSIDE_VAULT: .*\(symlink resolves outside the vault\)/, r.text);
  }
  assert.equal(fs.existsSync(path.join(base, 'outside', 'new.txt')), false);
  // A walk from inside the vault skips the link.
  const r = await call('grep_files', { path: J('wiki'), pattern: 'outside' });
  assert.ok(r.text.startsWith('No matches.'), r.text);
});

test('a module called directly: a hand-made path is refused, a checked one works', async () => {
  const forged = { path: path.join(base, 'outside') };
  assert.throws(() => P.policyForDir(forged, R.root), /^Error: UNVERIFIED_PATH: policyForDir requires a path produced by resolveSafe\(\), got object$/);
  assert.throws(() => P.policyForDir(path.join(base, 'outside'), R.root), /UNVERIFIED_PATH: policyForDir .* got string/);
  await assert.rejects(SQLITE.query(forged, 'SELECT 1'), /UNVERIFIED_PATH: sqlite_query/);
  await assert.rejects(SQLITE.schema(Object.freeze({ path: J('x.db') }), {}), /UNVERIFIED_PATH: sqlite_schema/);
  assert.throws(() => SP.child(forged, 'secret.txt'), /UNVERIFIED_PATH/);

  const ok = P.policyForDir(R.resolveSafe(J('wiki')), R.root);
  assert.equal(ok.overwrite, 'rev');
  assert.equal(P.trashDirOf(ok).path, J('wiki', '.vault-trash'));
});

test('the vault is set once per process', () => {
  assert.throws(() => S.init(base), /already set/);
});
