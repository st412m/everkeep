'use strict';
// Saving a marker writes only what the directory sets itself (§6): the page
// and `everkeep policy set` on the same input write the same bytes.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers.js');

process.env.ALLOW_LOCAL = 'true';
const S = require('../src/server.js');
const P = require('../src/policy.js');
const SP = require('../src/safepath.js');
const W = require('../src/policy-write.js');
const CLI = require('../src/cli.js');

const V = tmpDir();
const J = (...a) => path.join(V, ...a);
const ROOT_MARKER = '{"overwrite":"rev","trash":".vault-trash","retention_enabled":true,"retention_days":14}\n';
const OWN_MARKER = '{"overwrite":"rev","trash":".own","retention_enabled":true,"retention_days":5}\n';
fs.writeFileSync(J('.vault-policy'), ROOT_MARKER);
for (const d of ['a', 'b', 'c', 'd', 'e', 'f']) fs.mkdirSync(J(d));
fs.writeFileSync(J('e', '.vault-policy'), OWN_MARKER);
fs.writeFileSync(J('a', 'note.md'), 'note\n');
S.init(V, { policyMode: 'ha-ingress' });
const R = SP.createResolver(V);
const rev = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);

let page, base;
test.before(async () => {
  page = require('../src/policy-page.js').createPolicyPage({ vault: V });
  await new Promise(r => page.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${page.address().port}`;
});
test.after(() => new Promise(r => page.close(r)));

const tree = () => fetch(base + '/api/tree').then(r => r.json());

// What the page's save() sends for a change on an entry of /api/tree.
async function pageSave(dir, change) {
  const t = await tree();
  const cur = t.children.concat([t.root]).find(x => x.path === dir);
  const body = {
    path: dir,
    mode: change.mode !== undefined ? change.mode : (cur.mode === 'inherit' ? cur.effective : cur.mode),
    trash: change.trash !== undefined ? change.trash : !!cur.trash,
    trashName: cur.trashName,
    retention_enabled: change.retention_enabled !== undefined ? change.retention_enabled : !!cur.retention_enabled,
    retention_days: change.retention_days !== undefined ? change.retention_days : cur.retention_days,
  };
  const r = await fetch(base + '/api/policy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

// The bytes `everkeep policy set` would write, without writing.
function cliBytes(args) {
  const flags = CLI.parseSetArgs(args);
  assert.ok(!flags.error, flags.error);
  const dir = W.targetDir(R, path.isAbsolute(flags.dir) ? flags.dir : path.join(V, flags.dir));
  const change = CLI.changeFromFlags(flags, P.policyAt(dir, R.root).policy);
  return W.markerText(W.specOf(change, W.contextOf(R, dir)), 'ha-ingress');
}

const markerOf = fields => W.markerText(fields, 'ha-ingress');
const read = rel => fs.readFileSync(J(rel, '.vault-policy'), 'utf8');

test('a subdirectory that changes only its mode shares the trash above', async () => {
  const cli = cliBytes(['a', '--mode', 'free']);
  const r = await pageSave(J('a'), { mode: 'free' });
  assert.equal(r.ok, true, r.error);
  assert.equal(read('a'), cli);
  assert.equal(cli, markerOf({ readonly: false, overwrite: 'free' }));
  const pol = P.policyForDir(R.resolveSafe(J('a')), R.root, new Map());
  assert.equal(P.describePolicy(pol, J('a')), `Policy: overwrite=free, trash=.vault-trash in ${V}, auto-purge after 14 d — own marker (${J('a', '.vault-policy')})`);
  // trash_file from it lands in the trash of the root.
  const t = await S.handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'trash_file', arguments: { path: J('a', 'note.md'), rev: rev('note\n') } } });
  assert.ok(!t.result.isError, t.result.content[0].text);
  assert.ok(fs.readdirSync(J('.vault-trash', 'a')).some(n => n.startsWith('note__trash-')));
  assert.equal(fs.existsSync(J('a', '.vault-trash')), false);
  // The page names the directory whose trash it shares.
  const entry = (await tree()).children.find(c => c.name === 'a');
  assert.equal(entry.trashOwn, false);
  assert.equal(entry.trashOwner, V);
});

test('switching the trash off under a parent that has one writes "trash": null', async () => {
  const cli = cliBytes(['b', '--mode', 'rev', '--no-trash']);
  const r = await pageSave(J('b'), { trash: false });
  assert.equal(r.ok, true, r.error);
  assert.equal(read('b'), cli);
  assert.equal(cli, markerOf({ readonly: false, overwrite: 'rev', trash: null }));
});

test('switching it back on shares the parent trash again', async () => {
  const cli = cliBytes(['b', '--mode', 'rev', '--trash']);
  const r = await pageSave(J('b'), { trash: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(read('b'), cli);
  assert.equal(cli, markerOf({ readonly: false, overwrite: 'rev' }));
});

test('--trash NAME makes an own trash, with auto-purge', () => {
  assert.equal(cliBytes(['c', '--mode', 'rev', '--trash', '.bin']),
    markerOf({ readonly: false, overwrite: 'rev', trash: '.bin', retention_enabled: true, retention_days: 14 }));
  assert.equal(cliBytes(['c', '--mode', 'rev', '--trash', '.bin', '--no-purge']),
    markerOf({ readonly: false, overwrite: 'rev', trash: '.bin', retention_enabled: false, retention_days: 14 }));
  // The same name as the parent's, given explicitly: an own trash too.
  assert.equal(cliBytes(['c', '--mode', 'rev', '--trash', '.vault-trash', '--purge-days', '3']),
    markerOf({ readonly: false, overwrite: 'rev', trash: '.vault-trash', retention_enabled: true, retention_days: 3 }));
});

test('auto-purge on a shared trash is not written', () => {
  assert.equal(cliBytes(['d', '--mode', 'rev', '--purge-days', '3']), markerOf({ readonly: false, overwrite: 'rev' }));
});

test('a marker with its own trash keeps it when only the mode changes', async () => {
  const cli = cliBytes(['e', '--mode', 'free']);
  const r = await pageSave(J('e'), { mode: 'free' });
  assert.equal(r.ok, true, r.error);
  assert.equal(read('e'), cli);
  assert.equal(cli, markerOf({ readonly: false, overwrite: 'free', trash: '.own', retention_enabled: true, retention_days: 5 }));
  const entry = (await tree()).children.find(c => c.name === 'e');
  assert.equal(entry.trashOwn, true);
});

test('read-only: no trash of its own; null under a parent with one', async () => {
  const cli = cliBytes(['f', '--mode', 'readonly']);
  const r = await pageSave(J('f'), { mode: 'readonly' });
  assert.equal(r.ok, true, r.error);
  assert.equal(read('f'), cli);
  assert.equal(cli, markerOf({ readonly: true, overwrite: 'never', trash: null }));
});

test('the root keeps its own trash and auto-purge when only the mode changes', async () => {
  const cli = cliBytes([V, '--mode', 'never']);
  const r = await pageSave(V, { mode: 'never' });
  assert.equal(r.ok, true, r.error);
  assert.equal(fs.readFileSync(J('.vault-policy'), 'utf8'), cli);
  assert.equal(cli, markerOf({ readonly: false, overwrite: 'never', trash: '.vault-trash', retention_enabled: true, retention_days: 14 }));
});

test('a root without a parent trash gets its own when the trash is switched on', () => {
  const v2 = tmpDir();
  const R2 = SP.createResolver(v2);
  const dir = W.targetDir(R2, v2);
  const flags = CLI.parseSetArgs([v2, '--mode', 'rev', '--trash']);
  const spec = W.specOf(CLI.changeFromFlags(flags, P.policyAt(dir, R2.root).policy), W.contextOf(R2, dir));
  assert.deepEqual(spec, { readonly: false, overwrite: 'rev', trash: '.vault-trash', retention_enabled: false, retention_days: 30 });
  const off = W.specOf(CLI.changeFromFlags(CLI.parseSetArgs([v2, '--mode', 'rev', '--no-trash']), P.policyAt(dir, R2.root).policy), W.contextOf(R2, dir));
  assert.deepEqual(off, { readonly: false, overwrite: 'rev' });
});
