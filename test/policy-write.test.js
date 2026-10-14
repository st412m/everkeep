'use strict';
// policy-write.js, the wording of refusals, and the isolation of the MCP
// dispatcher from the marker writer.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers.js');

process.env.ALLOW_LOCAL = 'true';
const S = require('../src/server.js');
const P = require('../src/policy.js');
const SP = require('../src/safepath.js');
const W = require('../src/policy-write.js');
const CLI = require('../src/cli.js');
const { VERSION } = require('../src/version.js');

const V = tmpDir();
const J = (...a) => path.join(V, ...a);
fs.mkdirSync(J('wiki', 'sub'), { recursive: true });
fs.mkdirSync(J('notrash'));
fs.writeFileSync(J('wiki', '.vault-policy'), '{"overwrite":"rev","trash":".vault-trash","retention_enabled":true,"retention_days":14}\n');
fs.writeFileSync(J('notrash', '.vault-policy'), '{"overwrite":"free"}\n');
fs.writeFileSync(J('notrash', 'f.md'), 'f\n');
fs.mkdirSync(J('wiki', '.vault-trash', 'deep'), { recursive: true });
const R = S.init(V, { policyMode: 'off' });

const SRC = path.join(__dirname, '..', 'src');
const OFF = '`everkeep policy` on the server';
const HA = 'the Vault policies page in the Home Assistant sidebar';

async function call(name, args) {
  const r = await S.handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return { text: r.result.content.map(c => c.text).join('\n'), isError: r.result.isError === true };
}

// ---- isolation ----

test('server.js has no reference to policy-write.js and no writeFileSync on a marker path', () => {
  const src = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');
  assert.ok(!/policy-write/.test(src), 'server.js names policy-write');
  for (const line of src.split('\n').filter(l => l.includes('writeFileSync')))
    assert.ok(!/POLICY_FILE|vault-policy|marker/i.test(line), line);
  // At run time too: loading the dispatcher does not load the writer.
  const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(SRC, 'server.js'))}); console.log(Object.keys(require.cache).filter(k => k.includes('policy-write')).length)`], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), '0', r.stderr);
});

test('policy-write.js is required by policy-page.js and cli.js only', () => {
  const users = fs.readdirSync(SRC).filter(f => f.endsWith('.js') && /require\('\.\/policy-write'\)/.test(fs.readFileSync(path.join(SRC, f), 'utf8')));
  assert.deepEqual(users.sort(), ['cli.js', 'policy-page.js']);
  for (const f of fs.readdirSync(SRC).filter(f => f.endsWith('.js') && f !== 'policy-write.js'))
    assert.ok(!/renameSync\([^)]*(POLICY_FILE|vault-policy)/.test(fs.readFileSync(path.join(SRC, f), 'utf8')), f);
});

// ---- wording ----

test('refusals name the policy editor of the mode, and nothing names Samba or the add-on', async () => {
  for (const [mode, editor] of [['off', OFF], ['ha-ingress', HA]]) {
    P.setEditorMode(mode);
    let r = await call('write_file', { path: J('wiki', '.vault-policy'), content: '{}' });
    assert.equal(r.text, `Error: .vault-policy cannot be written through MCP tools — markers are edited with ${editor}. A directory or file of that name created here would lock the zone with no way to repair it from this side.`);
    r = await call('create_directory', { path: J('wiki', 'sub', '.VAULT-POLICY', 'x') });
    assert.ok(r.text.startsWith(`Error: .vault-policy cannot be created through MCP tools — markers are edited with ${editor}.`), r.text);
    r = await call('trash_file', { path: J('notrash', 'f.md') });
    assert.ok(r.text.endsWith(`so nothing can be discarded here. Turn the trash on for the zone with ${editor}.`), r.text);
  }
  P.setEditorMode('off');
  for (const f of ['server.js', 'policy.js', 'policy-write.js', 'cli.js']) {
    const src = fs.readFileSync(path.join(SRC, f), 'utf8');
    assert.ok(!/Samba|add-on|file editor/.test(src), f);
  }
});

test('broken markers: repair advice names the editor and the disk', () => {
  const d = tmpDir();
  fs.mkdirSync(path.join(d, 'bad'));
  fs.writeFileSync(path.join(d, 'bad', '.vault-policy'), '{"readonly":fals');
  fs.mkdirSync(path.join(d, 'dirmarker', '.vault-policy'), { recursive: true });
  const R2 = SP.createResolver(d);
  for (const [mode, editor] of [['off', OFF], ['ha-ingress', HA]]) {
    P.setEditorMode(mode);
    const bad = P.policyForDir(R2.resolveSafe(path.join(d, 'bad')), R2.root, new Map());
    assert.ok(bad.error.endsWith(`The zone is locked (read-only, no deletion) until the file is fixed — edit it with ${editor}, or fix the file on disk.`), bad.error);
    const dm = P.policyForDir(R2.resolveSafe(path.join(d, 'dirmarker')), R2.root, new Map());
    assert.ok(dm.error.endsWith(`makes the zone unreadable. Remove it on disk.`), dm.error);
  }
  P.setEditorMode('off');
});

test('the marker preamble names the editor and stays parseable', () => {
  assert.equal(W.preamble('off'), `Everkeep policy. Applies to this directory and everything below it, until a deeper marker of the same name is met. Managed with ${OFF} — edit by hand only to repair it.`);
  assert.equal(W.preamble('ha-ingress'), `Everkeep policy. Applies to this directory and everything below it, until a deeper marker of the same name is met. Managed with ${HA} — edit by hand only to repair it.`);
  const text = W.markerText(W.specOf({ mode: 'rev', trash: true, retention_enabled: true, retention_days: 7 }), 'off');
  assert.deepEqual(P.parseMarker(text), { readonly: false, overwrite: 'rev', trash: '.vault-trash', retention_enabled: true, retention_days: 7 });
  assert.equal(text, JSON.stringify({ _: W.preamble('off'), readonly: false, overwrite: 'rev', trash: '.vault-trash', retention_enabled: true, retention_days: 7 }, null, 2) + '\n');
});

// ---- the directory a marker may go into ----

test('targetDir: outside, through a marker name, in the trash, missing, a file — refused', () => {
  fs.writeFileSync(J('wiki', 'file.md'), 'x\n');
  const bad = [
    [path.join(V, '..'), /PATH_OUTSIDE_VAULT/],
    [J('wiki', '.vault-policy', 'x'), /a path through \.vault-policy cannot hold a marker/],
    [J('wiki', '.VAULT-POLICY'), /a path through \.vault-policy cannot hold a marker/],
    [J('wiki', '.vault-trash'), /is in the trash; a marker cannot go there/],
    [J('wiki', '.vault-trash', 'deep'), /is in the trash; a marker cannot go there/],
    [J('wiki', '.VAULT-TRASH'), /is in the trash|does not exist/],
    [J('missing'), /does not exist$/],
    [J('wiki', 'file.md'), /is not a directory$/],
  ];
  for (const [p, re] of bad) assert.throws(() => W.targetDir(R, p), re, p);
  assert.equal(W.targetDir(R, J('wiki', 'sub')).path, J('wiki', 'sub'));
  assert.equal(W.targetDir(R, V).path, V);
});

// ---- the same bytes from the page and from the CLI flags ----

test('page and `policy set` flags give the same marker bytes', () => {
  const dir = R.resolveSafe(J('wiki'));
  const policy = P.policyAt(dir, R.root).policy;
  const ctx = W.contextOf(R, dir);
  const cases = [
    [['wiki', '--mode', 'rev', '--trash', '--purge-days', '14'], { mode: 'rev', trash: true, trashName: '.vault-trash', retention_enabled: true, retention_days: 14 }],
    [['wiki', '--mode', 'never', '--no-trash', '--no-purge'], { mode: 'never', trash: false, trashName: '.vault-trash', retention_enabled: false, retention_days: 14 }],
    [['wiki', '--mode', 'free', '--trash', '.bin'], { mode: 'free', trash: true, trashName: '.bin', trashNameGiven: true, retention_enabled: true, retention_days: 14 }],
    [['wiki', '--mode', 'readonly'], { mode: 'readonly', trash: true, trashName: '.vault-trash', retention_enabled: true, retention_days: 14 }],
  ];
  for (const [args, pageBody] of cases) {
    const flags = CLI.parseSetArgs(args);
    assert.ok(!flags.error, flags.error);
    const fromCli = W.markerText(W.specOf(CLI.changeFromFlags(flags, policy), ctx), 'ha-ingress');
    const fromPage = W.markerText(W.specOf(pageBody, ctx), 'ha-ingress');
    assert.equal(fromCli, fromPage, args.join(' '));
  }
});

test('policy set argument errors', () => {
  const bad = [
    [[], /needs DIR/], [['wiki'], /needs --mode/], [['wiki', '--mode', 'strict'], /--mode must be one of readonly, rev, free, never/],
    [['wiki', '--mode'], /--mode needs a value/], [['wiki', '--mode', 'rev', '--trash', '--no-trash'], /exclude each other/],
    [['wiki', '--mode', 'rev', '--purge-days', 'x'], /whole number/], [['wiki', '--mode', 'rev', '--purge-days', '3', '--no-purge'], /exclude each other/],
    [['wiki', '--mode', 'rev', '--bogus'], /unknown option --bogus/], [['wiki', 'more', '--mode', 'rev'], /unexpected argument "more"/],
  ];
  for (const [args, re] of bad) assert.match(CLI.parseSetArgs(args).error || '', re, args.join(' '));
  assert.deepEqual(CLI.parseSetArgs(['wiki', '--mode=free', '--trash=.bin', '--purge-days=3']), { dir: 'wiki', mode: 'free', trash: true, trashName: '.bin', purge: 3 });
});

// ---- the page ----

test('page: writes through policy-write; subtitle shows everkeep and its version', async () => {
  const page = require('../src/policy-page.js').createPolicyPage({ vault: V });
  await new Promise(r => page.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${page.address().port}`;
  try {
    const html = await (await fetch(base + '/')).text();
    assert.ok(html.includes('DATA.vault + " · everkeep " + DATA.version'), 'subtitle');
    assert.ok(html.includes('<title>Vault policies</title>'));
    assert.equal((await (await fetch(base + '/api/tree')).json()).version, VERSION);
    const post = body => fetch(base + '/api/policy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
    let r = await post({ path: J('wiki', 'sub'), mode: 'never', trash: false, trashName: '.vault-trash', retention_enabled: false, retention_days: 30 });
    assert.deepEqual(r, { ok: true, message: `Saved: ${J('wiki', 'sub', '.vault-policy')}` });
    assert.equal(fs.readFileSync(J('wiki', 'sub', '.vault-policy'), 'utf8'),
      W.markerText({ readonly: false, overwrite: 'never', trash: null }, 'ha-ingress'));
    r = await post({ path: J('wiki', '.vault-trash'), mode: 'free' });
    assert.equal(r.ok, false);
    assert.match(r.error, /is in the trash/);
    r = await post({ path: J('wiki', 'sub'), mode: 'inherit' });
    assert.deepEqual(r, { ok: true, message: `Marker removed: ${J('wiki', 'sub', '.vault-policy')} — this directory now follows the rule above it.` });
    assert.equal(fs.existsSync(J('wiki', 'sub', '.vault-policy')), false);
    assert.deepEqual(fs.readdirSync(J('wiki', 'sub')), [], 'no temp file left');
  } finally {
    await new Promise(r => page.close(r));
  }
});
