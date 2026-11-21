'use strict';
// everkeep init: a new vault with an instruction file, a starter policy and the
// default-vault entry; nothing that exists is changed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { initCommand } = require('../src/cli.js');
const { STARTER_TEXT } = require('../src/starter.js');
const { tmpDir, writeJson, SKIP_CLI, isolatedEnv } = require('./helpers.js');

// Runs init in-process with stdout and stderr captured.
async function run(args, home, extraEnv = {}) {
  const out = [], err = [];
  const stdoutWrite = process.stdout.write, stderrWrite = process.stderr.write;
  process.stdout.write = chunk => { out.push(String(chunk)); return true; };
  process.stderr.write = chunk => { err.push(String(chunk)); return true; };
  let code;
  try {
    code = await initCommand(args, { env: isolatedEnv(home, extraEnv), homedir: home, interactive: false });
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
  return { code, stdout: out.join(''), stderr: err.join('') };
}

const cfgOf = home => path.join(home, '.config', 'everkeep', 'config.json');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const exists = p => fs.existsSync(p);

// Every file below dir, keyed by relative path, with its bytes.
function snapshot(dir) {
  const files = {};
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const p = path.join(e.parentPath, e.name);
    files[path.relative(dir, p)] = fs.readFileSync(p);
  }
  return files;
}

const MARKER = JSON.stringify({ _: 'test marker', readonly: false, overwrite: 'free' }, null, 2) + '\n';

test('fresh home, no args: CLAUDE.md, rev marker with trash, config saved', { skip: SKIP_CLI }, async () => {
  const home = tmpDir();
  const vault = path.join(home, 'everkeep');
  const r = await run([], home);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(fs.readFileSync(path.join(vault, 'CLAUDE.md')).equals(Buffer.from(STARTER_TEXT, 'utf8')));
  assert.equal(exists(path.join(vault, 'AGENTS.md')), false);
  const marker = readJson(path.join(vault, '.vault-policy'));
  assert.equal(marker.overwrite, 'rev');
  assert.equal(typeof marker.trash, 'string');
  assert.deepEqual(readJson(cfgOf(home)), { vault });
  assert.match(r.stdout, /claude mcp add --scope user --transport stdio everkeep/);
});

test('--agent other: AGENTS.md', { skip: SKIP_CLI }, async () => {
  const home = tmpDir();
  const vault = path.join(home, 'everkeep');
  const r = await run(['--agent', 'other'], home);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(fs.readFileSync(path.join(vault, 'AGENTS.md')).equals(Buffer.from(STARTER_TEXT, 'utf8')));
  assert.equal(exists(path.join(vault, 'CLAUDE.md')), false);
  assert.match(r.stdout, /Any MCP client over stdio/);
});

test('explicit DIR with CLAUDE.md and a marker: both left as they are', { skip: SKIP_CLI }, async () => {
  const home = tmpDir();
  const vault = path.join(home, 'notes');
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, 'CLAUDE.md'), '# My own rules\n');
  fs.writeFileSync(path.join(vault, '.vault-policy'), MARKER);
  const claude = fs.readFileSync(path.join(vault, 'CLAUDE.md'));
  const marker = fs.readFileSync(path.join(vault, '.vault-policy'));
  const r = await run([vault], home);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(fs.readFileSync(path.join(vault, 'CLAUDE.md')).equals(claude));
  assert.ok(fs.readFileSync(path.join(vault, '.vault-policy')).equals(marker));
  assert.equal(exists(path.join(vault, 'AGENTS.md')), false);
});

test('existing AGENTS.md, --agent claude: no CLAUDE.md', { skip: SKIP_CLI }, async () => {
  const home = tmpDir();
  const vault = path.join(home, 'everkeep');
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, 'AGENTS.md'), '# Agents\n');
  const agents = fs.readFileSync(path.join(vault, 'AGENTS.md'));
  const r = await run(['--agent', 'claude'], home);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(exists(path.join(vault, 'CLAUDE.md')), false);
  assert.ok(fs.readFileSync(path.join(vault, 'AGENTS.md')).equals(agents));
});

test('second run on the same home changes nothing', { skip: SKIP_CLI }, async () => {
  const home = tmpDir();
  const vault = path.join(home, 'everkeep');
  assert.equal((await run([], home)).code, 0);
  const files = snapshot(vault);
  const cfg = fs.readFileSync(cfgOf(home));
  const r = await run([], home);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(snapshot(vault), files);
  assert.ok(fs.readFileSync(cfgOf(home)).equals(cfg));
  assert.equal(r.stderr.split('exists, left as it is').length - 1, 2);
  assert.match(r.stderr, /already names it/);
});

test('DIR is the home folder or a filesystem root: refused, nothing created', { skip: SKIP_CLI }, async () => {
  const home = tmpDir();
  let r = await run([home], home);
  assert.equal(r.code, 1);
  assert.equal(exists(path.join(home, '.config')), false);
  assert.deepEqual(fs.readdirSync(home), []);
  r = await run([path.parse(home).root], home);
  assert.equal(r.code, 1);
  assert.deepEqual(fs.readdirSync(home), []);
});

test('config naming another vault: refused, file unchanged', { skip: SKIP_CLI }, async () => {
  const home = tmpDir();
  writeJson(cfgOf(home), { vault: '/somewhere/else', port: 3200 });
  const cfg = fs.readFileSync(cfgOf(home));
  const r = await run([], home);
  assert.equal(r.code, 1);
  assert.ok(fs.readFileSync(cfgOf(home)).equals(cfg));
  assert.equal(exists(path.join(home, 'everkeep')), false);
});

test('config without a vault: the vault is added, other keys kept', { skip: SKIP_CLI }, async () => {
  const home = tmpDir();
  writeJson(cfgOf(home), { port: 3200 });
  const r = await run([], home);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(readJson(cfgOf(home)), { port: 3200, vault: path.join(home, 'everkeep') });
});

test('EVERKEEP_CONFIG set: refused, nothing created', { skip: SKIP_CLI }, async () => {
  const home = tmpDir();
  const r = await run([], home, { EVERKEEP_CONFIG: path.join(home, 'elsewhere.json') });
  assert.equal(r.code, 1);
  assert.deepEqual(fs.readdirSync(home), []);
});

test('--agent with an unknown value: usage error', { skip: SKIP_CLI }, async () => {
  const home = tmpDir();
  const r = await run(['--agent', 'bogus'], home);
  assert.equal(r.code, 2);
});

test('DIR is a regular file: refused', { skip: SKIP_CLI }, async () => {
  const home = tmpDir();
  const file = path.join(home, 'note.md');
  fs.writeFileSync(file, 'hello\n');
  const r = await run([file], home);
  assert.equal(r.code, 1);
});
