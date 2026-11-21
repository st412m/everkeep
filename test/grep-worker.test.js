'use strict';
// grep_files runs in a worker thread, not a child process: a catastrophic regex
// is stopped by the timeout without blocking the main thread, and no child
// process is started (Claude Desktop's built-in Node refuses to spawn itself).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { tmpDir } = require('./helpers.js');

// Before server.js is loaded: any child process started by grep fails.
for (const name of ['fork', 'spawn', 'execFile']) {
  cp[name] = () => { throw new Error(`${name} is not available here`); };
}
const S = require('../src/server.js');

const V = path.join(tmpDir(), 'vault');
fs.mkdirSync(V);
fs.writeFileSync(path.join(V, 'slow.md'), 'a'.repeat(40) + '!\n');
fs.writeFileSync(path.join(V, 'note.md'), 'first line\nneedle here\n');
S.init(V);

async function call(name, args) {
  const r = await S.handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return { text: r.result.content.map(c => c.text).join('\n'), isError: r.result.isError === true };
}

test('grep_files finds matches with child processes unavailable', async () => {
  const r = await call('grep_files', { path: V, pattern: 'needle' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /note\.md · rev [0-9a-f]{8} · 2 lines\n {2}2: needle here/);
});

test('a catastrophic regex is stopped at the timeout; the main thread keeps running; the next grep works', async () => {
  S.setGrepTimeout(1000);
  try {
    let ticks = 0;
    const tick = setInterval(() => { ticks++; }, 100);
    const t0 = Date.now();
    const r = await call('grep_files', { path: V, pattern: '^(a+)+$' });
    const ms = Date.now() - t0;
    clearInterval(tick);
    assert.equal(r.isError, true, r.text);
    assert.match(r.text, /grep timed out after 1s and was killed/);
    assert.ok(ms < 5000, `took ${ms} ms`);
    assert.ok(ticks >= 5, `main thread ticked ${ticks} times in ${ms} ms`);

    // A worker still backtracking would burn about a full core.
    const c0 = process.cpuUsage();
    await new Promise(res => setTimeout(res, 500));
    const used = process.cpuUsage(c0);
    assert.ok(used.user < 250000, `cpu user ${used.user} µs in 500 ms after the timeout`);

    const r2 = await call('grep_files', { path: V, pattern: 'needle' });
    assert.equal(r2.isError, false, r2.text);
    assert.match(r2.text, /needle here/);
  } finally {
    S.setGrepTimeout(10000);
  }
});
