'use strict';
// Case-insensitive vault (§8). Runs against a directory where the file system
// ignores case: EVERKEEP_TEST_CI_MOUNT names an empty directory on such a
// mount (ext4 with casefold and `chattr +F`, exFAT, NTFS). Each run works in a
// fresh subdirectory of it and removes it afterwards.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MOUNT = process.env.EVERKEEP_TEST_CI_MOUNT;
const skip = MOUNT ? false : 'EVERKEEP_TEST_CI_MOUNT is not set (path to an empty directory on a case-insensitive file system)';

let V = null;
let state = null;
let S, P, SP;
if (!skip) {
  V = fs.mkdtempSync(path.join(MOUNT, 'everkeep-ci-'));
  S = require('../src/server.js');
  P = require('../src/policy.js');
  SP = require('../src/safepath.js');
  // The document cache lives outside the mount, as state_dir always does.
  state = fs.mkdtempSync(path.join(require('os').tmpdir(), 'everkeep-ci-state-'));
  S.init(V, { docs: { stateDir: state } });
  test.after(() => fs.rmSync(state, { recursive: true, force: true }));
  test.after(() => fs.rmSync(V, { recursive: true, force: true }));
}

const J = (...a) => path.join(V, ...a);
const rev = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
const MARKER = '{"overwrite":"rev","trash":".vault-trash"}\n';
const OLD = 'old__trash-20260101T000000Z.md';

function write(rel, text) {
  fs.mkdirSync(path.dirname(J(rel)), { recursive: true });
  fs.writeFileSync(J(rel), text);
}

if (!skip) {
  write('wiki/.vault-policy', MARKER);
  write('wiki/page.md', 'page\n');
  write('wiki/note.md', 'needle\n');
  write('wiki/move-me.md', 'move\n');
  // The trash exists on disk under another case than the marker names it.
  write(`wiki/.VAULT-TRASH/${OLD}`, 'needle-in-trash\n');
  write('strict/.vault-policy', '{"overwrite":"never"}\n');
  fs.mkdirSync(J('strict', 'sub'), { recursive: true });
}

async function call(name, args) {
  const r = await S.handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return { text: r.result.content.map(c => c.text).join('\n'), isError: r.result.isError === true };
}

const MARKER_REFUSAL = '.vault-policy cannot be written through MCP tools';

test('the stand ignores case', { skip }, () => {
  assert.ok(fs.existsSync(J('WIKI', '.VAULT-POLICY')), `${MOUNT} is not case-insensitive — set up the stand with chattr +F`);
  assert.equal(SP.probeCase(V), 'insensitive');
});

test('samePath: case-only difference on the same file is the same path', { skip }, () => {
  assert.equal(SP.samePath(J('wiki', '.vault-trash'), J('wiki', '.VAULT-TRASH')), true);
  assert.equal(SP.samePath(J('WIKI', 'page.md'), J('wiki', 'Page.MD')), true);
  assert.equal(SP.samePath(J('wiki', 'page.md'), J('wiki', 'note.md')), false);
  assert.equal(SP.samePath(J('wiki', 'gone.md'), J('wiki', 'GONE.md')), false, 'ENOENT is not the same');
});

test('write_file .VAULT-POLICY is refused with and without the rev, the marker stays', { skip }, async () => {
  let r = await call('write_file', { path: J('wiki', '.VAULT-POLICY'), content: '{}' });
  assert.ok(r.isError, r.text);
  assert.ok(r.text.includes(MARKER_REFUSAL), r.text);
  // The rev a 2.9.0 refusal handed out: the rev of the marker itself.
  r = await call('write_file', { path: J('wiki', '.VAULT-POLICY'), content: '{}', rev: rev(MARKER) });
  assert.ok(r.isError && r.text.includes(MARKER_REFUSAL), r.text);
  for (const name of ['.Vault-Policy', '.vault-POLICY']) {
    r = await call('write_file', { path: J('wiki', name), content: '{}', rev: rev(MARKER) });
    assert.ok(r.isError && r.text.includes(MARKER_REFUSAL), `${name}: ${r.text}`);
  }
  r = await call('edit_file', { path: J('wiki', '.VAULT-POLICY'), rev: rev(MARKER), edits: [{ oldText: '"rev"', newText: '"free"' }] });
  assert.ok(r.isError && r.text.includes('.vault-policy cannot be edited through MCP tools'), r.text);
  r = await call('move_file', { source: J('wiki', 'page.md'), destination: J('wiki', '.VAULT-POLICY') });
  assert.ok(r.isError && r.text.includes('.vault-policy cannot be created through MCP tools'), r.text);
  r = await call('trash_file', { path: J('wiki', '.VAULT-POLICY'), rev: rev(MARKER) });
  assert.ok(r.isError && r.text.includes('.vault-policy cannot be discarded through MCP tools'), r.text);
  assert.equal(fs.readFileSync(J('wiki', '.vault-policy'), 'utf8'), MARKER);
});

test('a never zone: .VAULT-POLICY in a subdirectory is refused, as a file or a directory', { skip }, async () => {
  let r = await call('write_file', { path: J('strict', 'sub', '.VAULT-POLICY'), content: '{"overwrite":"free"}' });
  assert.ok(r.isError && r.text.includes(MARKER_REFUSAL), r.text);
  r = await call('create_directory', { path: J('strict', 'sub', '.Vault-Policy') });
  assert.ok(r.isError && r.text.includes('.vault-policy cannot be created through MCP tools'), r.text);
  assert.deepEqual(fs.readdirSync(J('strict', 'sub')), []);
});

test('.VAULT-POLICY as a directory in the path is refused; the zone keeps its policy', { skip }, async () => {
  fs.mkdirSync(J('wiki', 'deep'), { recursive: true });
  fs.writeFileSync(J('wiki', 'deep', 'page.md'), 'deep\n');
  for (const zone of ['deep', '']) {
    const Z = (...a) => J('wiki', zone, ...a);
    for (const [tool, args, verb] of [
      ['write_file', { path: Z('.VAULT-POLICY', 'x.md'), content: 'x' }, 'written'],
      ['write_file', { path: Z('.vault-policy', 'x.md'), content: 'x' }, 'written'],
      ['create_directory', { path: Z('.Vault-Policy', 'sub') }, 'created'],
      ['move_file', { source: Z('page.md'), destination: Z('.VAULT-POLICY', 'page.md') }, 'created'],
    ]) {
      const r = await call(tool, args);
      // Where the marker file itself is on the way, Linux stops the path
      // earlier (realpath: ENOTDIR).
      const ok = r.text.startsWith(`Error: .vault-policy cannot be ${verb} through MCP tools`) ||
        (zone === '' && r.text.startsWith('Error: ENOTDIR: not a directory'));
      assert.ok(r.isError && ok, `${zone} ${tool}: ${r.text}`);
    }
  }
  assert.deepEqual(fs.readdirSync(J('wiki', 'deep')), ['page.md']);
  assert.equal(fs.readFileSync(J('wiki', '.vault-policy'), 'utf8'), MARKER);
  const r = await call('list_directory', { path: J('wiki', 'deep') });
  assert.equal(r.text.split('\n')[0], `Policy: overwrite=rev, trash=.vault-trash in ${J('wiki')} — inherited from ${J('wiki', '.vault-policy')}`);
  const w = await call('write_file', { path: J('wiki', 'deep', 'fresh.md'), content: 'fresh\n' });
  assert.ok(!w.isError && w.text.startsWith('Written: '), w.text);
});

test('write_file into .VAULT-TRASH behaves as into .vault-trash', { skip }, async () => {
  const a = await call('write_file', { path: J('wiki', '.VAULT-TRASH', 'x.md'), content: 'x\n' });
  const b = await call('write_file', { path: J('wiki', '.vault-trash', 'y.md'), content: 'y\n' });
  assert.equal(a.isError, b.isError, `${a.text}\n${b.text}`);
  assert.ok(!a.isError, a.text);
  assert.deepEqual(fs.readdirSync(J('wiki', '.vault-trash')).sort(), ['old__trash-20260101T000000Z.md', 'x.md', 'y.md']);
});

test('move_file into .VAULT-TRASH is refused as moving into the trash by hand', { skip }, async () => {
  for (const name of ['.VAULT-TRASH', '.vault-trash', '.Vault-Trash']) {
    const r = await call('move_file', { source: J('wiki', 'move-me.md'), destination: J('wiki', name, 'move-me.md'), rev: rev('move\n') });
    assert.ok(r.isError && r.text.includes('do not move things into the trash by hand; use trash_file'), `${name}: ${r.text}`);
  }
  assert.ok(fs.existsSync(J('wiki', 'move-me.md')));
});

test('walks skip the trash under any case: grep, search, tree', { skip }, async () => {
  let r = await call('grep_files', { path: J('wiki'), pattern: 'needle-in-trash' });
  assert.ok(r.text.startsWith('No matches.'), r.text);
  r = await call('grep_files', { path: J('wiki'), pattern: 'needle' });
  assert.ok(r.text.startsWith(`${J('wiki', 'note.md')} · rev `), r.text);
  assert.ok(!r.text.includes('old__trash'), r.text);
  r = await call('search_files', { path: J('wiki'), pattern: 'old__trash' });
  assert.equal(r.text, 'No matches\n\n(1 trash directory not searched)');
  r = await call('directory_tree', { path: J('wiki') });
  assert.ok(!/vault-trash/i.test(r.text.split('\n\n')[1]), r.text);
  assert.ok(r.text.includes('(1 trash directory omitted'), r.text);
  // From the vault root too, where the zone's trash is met one level down.
  r = await call('search_files', { path: V, pattern: 'old__trash' });
  assert.equal(r.text, 'No matches\n\n(1 trash directory not searched)');
});

test('bulk reads skip the trash under any case; trash_file says it is already there', { skip }, async () => {
  for (const name of ['.VAULT-TRASH', '.vault-trash']) {
    let r = await call('read_multiple_files', { paths: [J('wiki', name, OLD)] });
    assert.ok(r.text.includes('bulk reads skip it'), `${name}: ${r.text}`);
    r = await call('trash_file', { path: J('wiki', name, OLD), rev: rev('needle-in-trash\n') });
    assert.ok(r.isError && r.text.includes('is already in the trash'), `${name}: ${r.text}`);
  }
  // read_text_file still opens it.
  const r = await call('read_text_file', { path: J('wiki', '.VAULT-TRASH', OLD) });
  assert.equal(r.text, 'needle-in-trash\n');
});

test('trash_file lands in the existing trash; the zone keeps overwrite=rev, no orphan note', { skip }, async () => {
  let r = await call('trash_file', { path: J('wiki', 'page.md'), rev: rev('page\n') });
  assert.ok(!r.isError, r.text);
  assert.ok(fs.readdirSync(J('wiki', '.VAULT-TRASH')).some(n => n.startsWith('page__trash-')));
  r = await call('list_directory', { path: J('wiki') });
  assert.equal(r.text.split('\n')[0], `Policy: overwrite=rev, trash=.vault-trash — own marker (${J('wiki', '.vault-policy')})`);
  assert.ok(!r.text.includes('looks like a trash directory'), r.text);
  r = await call('write_file', { path: J('wiki', 'note.md'), content: 'changed\n' });
  assert.ok(r.isError && r.text.includes('requires its current rev'), r.text);
});

test('retention sweeps a trash met under another case once', { skip }, () => {
  write('arch/.vault-policy', '{"trash":".vault-trash","retention_enabled":true,"retention_days":1}\n');
  write(`arch/.VAULT-TRASH/${OLD}`, 'old\n');
  const R = SP.createResolver(V);
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (s, ...rest) => { lines.push(String(s)); return true; };
  try { require('../src/retention.js').runSweep(R.root); }
  finally { process.stderr.write = orig; }
  assert.equal(fs.existsSync(J('arch', '.VAULT-TRASH', OLD)), false, lines.join(''));
  assert.equal(lines.filter(l => l.includes('removed 1 file(s)')).length, 1, lines.join(''));
});

test('a marker on disk as .VAULT-POLICY is written over in place, never joined by a second file', { skip }, () => {
  const W = require('../src/policy-write.js');
  const R = SP.createResolver(V);
  write('upper/.VAULT-POLICY', '{"overwrite":"never"}\n');
  const dir = W.targetDir(R, J('upper'));
  assert.equal(W.markerPath(dir).path, J('upper', '.VAULT-POLICY'));
  const file = W.writeMarker(R, dir, W.specOf({ mode: 'rev' }), 'off');
  assert.equal(file, J('upper', '.VAULT-POLICY'));
  assert.deepEqual(fs.readdirSync(J('upper')), ['.VAULT-POLICY']);
  assert.equal(P.policyForDir(R.resolveSafe(J('upper')), R.root, new Map()).overwrite, 'rev');
  assert.throws(() => W.targetDir(R, J('upper', '.Vault-Policy')), /a path through \.vault-policy cannot hold a marker/);
  assert.throws(() => W.targetDir(R, J('wiki', '.VAULT-TRASH')), /is in the trash/);

  const { NATIVE, CLI, isolatedEnv } = require('./helpers.js');
  if (!NATIVE) return;
  const { spawnSync } = require('child_process');
  const env = isolatedEnv(fs.mkdtempSync(path.join(MOUNT, 'everkeep-home-')), { EVERKEEP_VAULT: V });
  try {
    let r = spawnSync(process.execPath, [CLI, 'policy', 'set', 'upper', '--mode', 'free'], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.split('\n')[0], `Saved: ${J('upper', '.VAULT-POLICY')}`);
    assert.deepEqual(fs.readdirSync(J('upper')), ['.VAULT-POLICY']);
    assert.match(fs.readFileSync(J('upper', '.VAULT-POLICY'), 'utf8'), /"overwrite": "free"/);
    r = spawnSync(process.execPath, [CLI, 'policy', 'set', 'wiki/.VAULT-TRASH', '--mode', 'free'], { env, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is in the trash/);
    r = spawnSync(process.execPath, [CLI, 'policy', 'clear', 'upper'], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.split('\n')[0], `Marker removed: ${J('upper', '.VAULT-POLICY')} — this directory now follows the rule above it.`);
    assert.deepEqual(fs.readdirSync(J('upper')), []);
  } finally {
    fs.rmSync(env.HOME, { recursive: true, force: true });
  }
});

test('a subdirectory saved with only a mode shares the parent trash that lies on disk as .VAULT-TRASH', { skip }, async () => {
  const W = require('../src/policy-write.js');
  const CLI = require('../src/cli.js');
  const R = SP.createResolver(V);
  write('wiki/share/doc.md', 'doc\n');
  const dir = W.targetDir(R, J('wiki', 'share'));
  const flags = CLI.parseSetArgs([J('wiki', 'share'), '--mode', 'free']);
  W.writeMarker(R, dir, W.specOf(CLI.changeFromFlags(flags, P.policyAt(dir, R.root).policy), W.contextOf(R, dir)), 'off');
  assert.equal(fs.readFileSync(J('wiki', 'share', '.vault-policy'), 'utf8'), W.markerText({ readonly: false, overwrite: 'free' }, 'off'));
  const r = await call('trash_file', { path: J('wiki', 'share', 'doc.md') });
  assert.ok(!r.isError, r.text);
  assert.ok(fs.readdirSync(J('wiki', '.VAULT-TRASH', 'share')).some(n => n.startsWith('doc__trash-')));
  assert.equal(fs.existsSync(J('wiki', 'share', '.vault-trash')), false);
  // Switching it off writes null; a name gives an own trash.
  const off = W.specOf(CLI.changeFromFlags(CLI.parseSetArgs([J('wiki', 'share'), '--mode', 'free', '--no-trash']), P.policyAt(dir, R.root).policy), W.contextOf(R, dir));
  assert.deepEqual(off, { readonly: false, overwrite: 'free', trash: null });
  const own = W.specOf(CLI.changeFromFlags(CLI.parseSetArgs([J('wiki', 'share'), '--mode', 'free', '--trash', '.bin']), P.policyAt(dir, R.root).policy), W.contextOf(R, dir));
  assert.equal(own.trash, '.bin');
});

test('documents: read under another case, grep skips one in .VAULT-TRASH, edit refused', { skip }, async () => {
  const FIX = path.join(__dirname, 'fixtures', 'documents');
  fs.copyFileSync(path.join(FIX, 'text.docx'), J('wiki', 'Doc.docx'));
  fs.copyFileSync(path.join(FIX, 'text.xlsx'), J('wiki', '.VAULT-TRASH', 'gone__trash-20260101T000000Z.xlsx'));
  let r = await call('read_text_file', { path: J('WIKI', 'DOC.DOCX'), offset: 8, limit: 1 });
  assert.equal(r.text, `${J('WIKI', 'DOC.DOCX')} · Word document (.docx) · lines 8-8 of 11
8| Temperature | −40 | 105`);
  r = await call('grep_files', { path: J('wiki'), pattern: 'Temperature' });
  assert.ok(r.text.includes(`${J('wiki', 'Doc.docx')} · Word document (.docx) · 11 lines
  L8: Temperature | −40 | 105`), r.text);
  assert.ok(!r.text.includes('gone__trash'), r.text);
  r = await call('write_file', { path: J('wiki', 'doc.DOCX'), content: 'x', rev: rev('x') });
  assert.ok(r.isError && r.text.includes('read-only: document formats are not edited by this server'), r.text);
  // One cache entry for the document, whatever case its path is read under.
  const cache = path.join(state, 'doc-cache');
  const entries = () => fs.readdirSync(cache).filter(n => n.endsWith('.cache')).length;
  const n = entries();
  for (const p of [J('wiki', 'Doc.docx'), J('Wiki', 'doc.docx'), J('WIKI', 'DOC.DOCX')]) {
    const t = await call('read_text_file', { path: p, offset: 1, limit: 1 });
    assert.ok(!t.isError, t.text);
  }
  assert.equal(entries(), n, 'no entry per spelling');
});

test('policy page: the root trash under another case is not listed as a zone', { skip }, async () => {
  write('.vault-policy', '{"trash":".vault-trash"}\n');
  fs.mkdirSync(J('.VAULT-TRASH'), { recursive: true });
  process.env.ALLOW_LOCAL = 'true';
  const server = require('../src/policy-page.js').createPolicyPage({ vault: V });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const tree = await (await fetch(`http://127.0.0.1:${server.address().port}/api/tree`)).json();
    assert.deepEqual(tree.children.map(c => c.name), ['arch', 'strict', 'upper', 'wiki']);
    assert.deepEqual(tree.deeper.map(d => d.path), [J('wiki', 'share')]);
  } finally {
    await new Promise(r => server.close(r));
    fs.rmSync(J('.vault-policy'));
  }
});
