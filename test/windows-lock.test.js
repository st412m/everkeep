'use strict';
// A marker held open by another program without delete sharing (an editor, an
// antivirus scan) on Windows: policy set and clear say so in plain words and
// leave the marker as it was; a marker released within the retries is written.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { tmpDir, CLI, isolatedEnv } = require('./helpers.js');

const WIN = process.platform === 'win32';
const skip = WIN ? false : 'runs on Windows';
const MARKER = '{"overwrite":"rev","trash":".vault-trash"}\n';

// Opens `file` in a PowerShell process with the given FileShare and keeps it
// open for `ms` milliseconds or until stop() is called.
function hold(file, share, ms = 60000) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$f = [System.IO.File]::Open($env:EK_PATH, 'Open', 'Read', '${share}'); Write-Output ready; Start-Sleep -Milliseconds ${ms}; $f.Close()`],
    { env: { ...process.env, EK_PATH: file }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    ps.stdout.on('data', d => {
      out += d;
      if (out.includes('ready')) resolve({ stop: () => new Promise(r => { ps.once('exit', r); ps.kill(); }) });
    });
    ps.on('error', reject);
    ps.on('exit', code => reject(new Error(`holder exited (${code}) before it was ready: ${out}`)));
  });
}

function setup() {
  const base = tmpDir();
  const V = path.join(base, 'vault');
  fs.mkdirSync(path.join(V, 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(V, 'wiki', '.vault-policy'), MARKER);
  return { base, V, home: path.join(base, 'home'), marker: path.join(V, 'wiki', '.vault-policy') };
}

for (const share of ['Read', 'ReadWrite']) {
  test(`policy set and clear while the marker is open with FileShare ${share}`, { skip, timeout: 60000 }, async t => {
    const s = setup();
    fs.mkdirSync(s.home);
    const env = isolatedEnv(s.home, { EVERKEEP_VAULT: s.V });
    const h = await hold(s.marker, share);
    let set, clear;
    try {
      set = spawnSync(process.execPath, [CLI, 'policy', 'set', 'wiki', '--mode', 'free'], { env, encoding: 'utf8', timeout: 30000 });
      clear = spawnSync(process.execPath, [CLI, 'policy', 'clear', 'wiki'], { env, encoding: 'utf8', timeout: 30000 });
    } finally {
      await h.stop();
    }
    t.diagnostic(`set: ${set.stderr.trim()}`);
    t.diagnostic(`clear: ${clear.stderr.trim()}`);
    assert.equal(set.status, 1);
    assert.equal(set.stderr, `everkeep: ${s.marker} is open in another program (EPERM); close it and try again — the marker was not changed\n`);
    assert.equal(clear.status, 1);
    assert.equal(clear.stderr, `everkeep: ${s.marker} is open in another program (EBUSY); close it and try again — the marker was not removed\n`);
    assert.equal(fs.readFileSync(s.marker, 'utf8'), MARKER);
    assert.deepEqual(fs.readdirSync(path.join(s.V, 'wiki')), ['.vault-policy']);
  });
}

test('a marker released within the retries is written', { skip, timeout: 60000 }, async t => {
  const s = setup();
  fs.mkdirSync(s.home);
  const env = isolatedEnv(s.home, { EVERKEEP_VAULT: s.V });
  const h = await hold(s.marker, 'Read', 300);
  const t0 = Date.now();
  const set = spawnSync(process.execPath, [CLI, 'policy', 'set', 'wiki', '--mode', 'free'], { env, encoding: 'utf8', timeout: 30000 });
  t.diagnostic(`set took ${Date.now() - t0} ms: exit ${set.status} ${set.stderr.trim()}`);
  await h.stop();
  assert.equal(set.status, 0, set.stderr);
  assert.match(fs.readFileSync(s.marker, 'utf8'), /"overwrite": "free"/);
});
