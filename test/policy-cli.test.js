'use strict';
// `everkeep policy show|set|clear`, run as a user would. Linux only: the CLI
// refuses to start natively on Windows and macOS.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { tmpDir, writeJson, CLI, SKIP_CLI, isolatedEnv } = require('./helpers.js');

const skip = SKIP_CLI;
const OFF = '`everkeep policy` on the server';
const HA = 'the Vault policies page in the Home Assistant sidebar';
const preamble = editor => `Everkeep policy. Applies to this directory and everything below it, until a deeper marker of the same name is met. Managed with ${editor} — edit by hand only to repair it.`;
const marker = (editor, f) => JSON.stringify({ _: preamble(editor), ...f }, null, 2) + '\n';

function setup() {
  const base = tmpDir();
  const home = path.join(base, 'home');
  const V = path.join(base, 'vault');
  for (const d of [home, path.join(V, 'wiki', 'sub'), path.join(V, 'raw'), path.join(V, 'wiki', '.vault-trash', 'old')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(V, 'wiki', '.vault-policy'), '{"overwrite":"rev","trash":".vault-trash"}\n');
  fs.writeFileSync(path.join(V, 'wiki', 'page.md'), 'page\n');
  return { base, home, V, J: (...a) => path.join(V, ...a), env: isolatedEnv(home, { EVERKEEP_VAULT: V }) };
}

function run(args, env) {
  const r = spawnSync(process.execPath, [CLI, 'policy', ...args], { env, encoding: 'utf8', timeout: 20000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// Every file under dir, with its bytes: "nothing was written" is checked on this.
function snapshot(dir) {
  const out = {};
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { out[p + '/'] = ''; walk(p); }
      else out[p] = e.isSymbolicLink() ? `-> ${fs.readlinkSync(p)}` : fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

test('set: writes the marker, prints where and the policy now in force', { skip }, () => {
  const s = setup();
  const r = run(['set', 'raw', '--mode', 'readonly'], s.env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, `Saved: ${s.J('raw', '.vault-policy')}\nPolicy: read-only, no trash (deletion not available) — own marker (${s.J('raw', '.vault-policy')})\n`);
  assert.equal(fs.readFileSync(s.J('raw', '.vault-policy'), 'utf8'),
    marker(OFF, { readonly: true, overwrite: 'never' }));
  assert.equal((fs.statSync(s.J('raw', '.vault-policy')).mode & 0o777) & 0o022, 0, 'not group/other-writable');

  const r2 = run(['set', s.J('wiki', 'sub'), '--mode', 'never', '--trash', '.bin', '--purge-days', '7'], s.env);
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(fs.readFileSync(s.J('wiki', 'sub', '.vault-policy'), 'utf8'),
    marker(OFF, { readonly: false, overwrite: 'never', trash: '.bin', retention_enabled: true, retention_days: 7 }));
  assert.equal(r2.stdout.split('\n')[1], `Policy: overwrite=never, trash=.bin, auto-purge after 7 d — own marker (${s.J('wiki', 'sub', '.vault-policy')})`);
  assert.deepEqual(fs.readdirSync(s.J('wiki', 'sub')).sort(), ['.vault-policy'], 'no temp file left');
});

test('set: what is not given keeps the value in force, as the page does', { skip }, () => {
  const s = setup();
  let r = run(['set', 'wiki', '--mode', 'free'], s.env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(s.J('wiki', '.vault-policy'), 'utf8'),
    marker(OFF, { readonly: false, overwrite: 'free', trash: '.vault-trash', retention_enabled: false, retention_days: 30 }));
  r = run(['set', 'wiki', '--mode', 'rev', '--purge-days', '14'], s.env);
  assert.equal(fs.readFileSync(s.J('wiki', '.vault-policy'), 'utf8'),
    marker(OFF, { readonly: false, overwrite: 'rev', trash: '.vault-trash', retention_enabled: true, retention_days: 14 }));
  r = run(['set', 'wiki', '--mode', 'rev', '--no-trash', '--no-purge'], s.env);
  assert.equal(fs.readFileSync(s.J('wiki', '.vault-policy'), 'utf8'),
    marker(OFF, { readonly: false, overwrite: 'rev' }));
  r = run(['set', 'wiki', '--mode', 'readonly', '--trash'], s.env);
  assert.equal(r.code, 0);
  assert.equal(r.stderr, 'everkeep: note: a read-only zone has no trash; --trash is ignored\n');
});

test('set: the policy editor in the preamble follows policy_page.mode', { skip }, () => {
  const s = setup();
  const cfg = writeJson(path.join(s.base, 'c.json'), { vault: s.V, policy_page: { mode: 'ha-ingress' } });
  const r = run(['set', 'raw', '--mode', 'rev'], isolatedEnv(s.home, { EVERKEEP_CONFIG: cfg }));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(s.J('raw', '.vault-policy'), 'utf8'),
    marker(HA, { readonly: false, overwrite: 'rev' }));
});

test('set: invalid input never writes', { skip }, () => {
  const s = setup();
  fs.writeFileSync(s.J('wiki', 'file.md'), 'x\n');
  fs.mkdirSync(path.join(s.base, 'outside'));
  fs.symlinkSync(path.join(s.base, 'outside'), s.J('out-link'), 'dir');
  const before = snapshot(s.V);
  const cases = [
    [['set', 'raw', '--mode', 'strict'], 2, /--mode must be one of readonly, rev, free, never/],
    [['set', 'raw'], 2, /policy set needs --mode/],
    [['set', '--mode', 'rev'], 2, /policy set needs DIR/],
    [['set', 'raw', '--mode', 'rev', '--purge-days', 'ten'], 2, /--purge-days must be a whole number of days/],
    [['set', 'raw', '--mode', 'rev', '--trash', '--no-trash'], 2, /exclude each other/],
    [['set', 'raw', '--mode', 'rev', '--purge-days', '0'], 1, /"retention_days" must be a whole number of days between 1 and 3650/],
    [['set', 'raw', '--mode', 'rev', '--purge-days', '3651'], 1, /"retention_days"/],
    [['set', 'raw', '--mode', 'rev', '--trash', 'a\\b'], 1, /"trash" must be a single directory name, without path separators/],
    [['set', 'raw', '--mode', 'rev', '--trash', '.vault-POLICY'], 1, /"trash" must not be ".vault-policy"/],
    [['set', 'raw', '--mode', 'rev', '--trash', '..'], 1, /"trash" must not be "\." or "\.\."/],
    [['set', path.join(s.base, 'outside'), '--mode', 'rev'], 1, /PATH_OUTSIDE_VAULT/],
    [['set', '../outside', '--mode', 'rev'], 1, /PATH_OUTSIDE_VAULT/],
    [['set', 'out-link', '--mode', 'rev'], 1, /PATH_OUTSIDE_VAULT: .*symlink resolves outside the vault/],
    [['set', 'wiki/.vault-trash', '--mode', 'free'], 1, /is in the trash; a marker cannot go there/],
    [['set', 'wiki/.vault-trash/old', '--mode', 'free'], 1, /is in the trash; a marker cannot go there/],
    [['set', 'wiki/.Vault-Trash', '--mode', 'free'], 1, /does not exist/],
    [['set', 'wiki/.vault-policy', '--mode', 'free'], 1, /a path through \.vault-policy cannot hold a marker/],
    [['set', 'wiki/.VAULT-POLICY/x', '--mode', 'free'], 1, /a path through \.vault-policy cannot hold a marker/],
    [['set', 'missing', '--mode', 'free'], 1, /does not exist$/m],
    [['set', 'wiki/file.md', '--mode', 'free'], 1, /is not a directory$/m],
    [['nope'], 2, /policy needs show, set or clear/],
    [['clear'], 2, /policy clear needs DIR/],
    [['show', 'a', 'b'], 2, /policy show takes one DIR/],
  ];
  for (const [args, code, re] of cases) {
    const r = run(args, s.env);
    assert.equal(r.code, code, `${args.join(' ')}: ${r.stderr}`);
    assert.equal(r.stdout, '', args.join(' '));
    assert.match(r.stderr, re, args.join(' '));
    assert.ok(r.stderr.startsWith('everkeep: '), r.stderr);
  }
  assert.deepEqual(snapshot(s.V), before);
  assert.deepEqual(fs.readdirSync(path.join(s.base, 'outside')), []);
});

test('show: the policy at DIR and every marker below it, the text of the listing tools', { skip }, () => {
  const s = setup();
  run(['set', 'wiki/sub', '--mode', 'never'], s.env);
  let r = run(['show'], s.env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, [
    'Policy: none — unrestricted (no .vault-policy marker above this directory).',
    '',
    `Markers at and below ${s.V}:`,
    `Policy: overwrite=rev, trash=.vault-trash — own marker (${s.J('wiki', '.vault-policy')})`,
    `Policy: overwrite=never, trash=.vault-trash in ${s.J('wiki')} — own marker (${s.J('wiki', 'sub', '.vault-policy')})`,
    '',
  ].join('\n'));
  r = run(['show', 'wiki/sub'], s.env);
  assert.equal(r.stdout.split('\n')[0], `Policy: overwrite=never, trash=.vault-trash in ${s.J('wiki')} — own marker (${s.J('wiki', 'sub', '.vault-policy')})`);
  assert.equal(fs.readFileSync(s.J('wiki', 'sub', '.vault-policy'), 'utf8'), marker(OFF, { readonly: false, overwrite: 'never' }));
  r = run(['show', 'raw'], s.env);
  assert.equal(r.stdout, `Policy: none — unrestricted (no .vault-policy marker above this directory).\n\nNo markers at or below ${s.J('raw')}.\n`);
});

test('clear: removes a regular marker only; a missing one is not an error', { skip }, () => {
  const s = setup();
  run(['set', 'wiki/sub', '--mode', 'never'], s.env);
  let r = run(['clear', 'wiki/sub'], s.env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `Marker removed: ${s.J('wiki', 'sub', '.vault-policy')} — this directory now follows the rule above it.\nPolicy: overwrite=rev, trash=.vault-trash in ${s.J('wiki')} — inherited from ${s.J('wiki', '.vault-policy')}\n`);
  assert.equal(fs.existsSync(s.J('wiki', 'sub', '.vault-policy')), false);

  r = run(['clear', 'wiki/sub'], s.env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.split('\n')[0], `No marker in ${s.J('wiki', 'sub')}; nothing was removed.`);

  // A directory or a symlink named like the marker: refused, left in place.
  fs.mkdirSync(s.J('raw', '.vault-policy'));
  r = run(['clear', 'raw'], s.env);
  assert.equal(r.code, 1);
  assert.equal(r.stderr, `everkeep: ${s.J('raw', '.vault-policy')} is not a regular file (a directory or a symlink); nothing was removed — fix it on disk\n`);
  assert.ok(fs.statSync(s.J('raw', '.vault-policy')).isDirectory());
  fs.rmdirSync(s.J('raw', '.vault-policy'));
  fs.symlinkSync(s.J('wiki', '.vault-policy'), s.J('raw', '.vault-policy'));
  r = run(['clear', 'raw'], s.env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /is not a regular file \(a directory or a symlink\); nothing was removed — fix it on disk/);
  assert.ok(fs.lstatSync(s.J('raw', '.vault-policy')).isSymbolicLink());
  assert.ok(fs.existsSync(s.J('wiki', '.vault-policy')));

  // In the trash or through a marker name: refused like set.
  r = run(['clear', 'wiki/.vault-trash'], s.env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /is in the trash/);
});

test('a running server sees the new marker on the next call', { skip }, async () => {
  const s = setup();
  const S = require('../src/server.js');
  S.init(s.V);
  const call = async (name, args) => (await S.handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result;
  assert.ok(!(await call('write_file', { path: s.J('raw', 'a.md'), content: 'a' })).isError);
  run(['set', 'raw', '--mode', 'readonly'], s.env);
  const r = await call('write_file', { path: s.J('raw', 'b.md'), content: 'b' });
  assert.ok(r.isError && r.content[0].text.includes('is read-only by policy'), r.content[0].text);
  const l = await call('list_directory', { path: s.J('raw') });
  assert.equal(l.content[0].text.split('\n')[0], run(['show', 'raw'], s.env).stdout.split('\n')[0]);
});

test('--vault: overrides EVERKEEP_VAULT for show, set and clear; DIR is relative to it', { skip }, () => {
  const s = setup();
  const other = path.join(s.base, 'other');
  fs.mkdirSync(path.join(other, 'raw'), { recursive: true });
  const env = isolatedEnv(s.home, { EVERKEEP_VAULT: s.V });
  let r = run(['set', 'raw', '--mode', 'never', '--vault', other], env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.split('\n')[0], `Saved: ${path.join(other, 'raw', '.vault-policy')}`);
  assert.equal(fs.existsSync(s.J('raw', '.vault-policy')), false);
  r = run(['show', '--vault=' + other], env);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(`Markers at and below ${other}:`), r.stdout);
  r = run(['clear', '--vault', other, 'raw'], env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(other, 'raw', '.vault-policy')), false);
  // The vault given by the flag bounds DIR too.
  r = run(['set', s.J('raw'), '--mode', 'never', '--vault', other], env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /PATH_OUTSIDE_VAULT/);
  for (const args of [['show', '--vault'], ['show', '--vault', other, '--vault', other], ['show', '--bogus'], ['clear', 'raw', '--bogus'], ['set', 'raw', '--mode', 'rev', '--bogus']]) {
    r = run(args, env);
    assert.equal(r.code, 2, args.join(' '));
    assert.equal(r.stdout, '');
  }
});

test('set: --purge-days on a shared trash is not written and says why', { skip }, () => {
  const s = setup();
  const r = run(['set', 'wiki/sub', '--mode', 'rev', '--purge-days', '3'], s.env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, 'everkeep: note: auto-purge belongs to the directory that owns the trash; --purge-days is not written here (give --trash NAME for an own trash)\n');
  assert.equal(fs.readFileSync(s.J('wiki', 'sub', '.vault-policy'), 'utf8'), marker(OFF, { readonly: false, overwrite: 'rev' }));
});
