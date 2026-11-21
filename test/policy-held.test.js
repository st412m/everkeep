'use strict';
// retryHeld: a marker another program holds open on Windows is retried, then
// reported in plain words; other errors and other platforms pass through.
const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../src/policy-write.js');

const err = code => Object.assign(new Error(`raw ${code}`), { code });

test('a held file that is released in time: retried with growing pauses, then done', () => {
  let n = 0;
  const slept = [];
  const r = W.retryHeld(() => { if (n++ < 2) throw err('EBUSY'); return 'done'; }, 'F', 'u', { windows: true, sleep: ms => slept.push(ms) });
  assert.equal(r, 'done');
  assert.deepEqual(slept, [50, 100]);
});

test('a file still held after the last pause: one plain message naming the file and what was not done', () => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    const slept = [];
    assert.throws(() => W.retryHeld(() => { throw err(code); }, 'C:\\v\\.vault-policy', 'the marker was not changed', { windows: true, sleep: ms => slept.push(ms) }),
      e => e.message === `C:\\v\\.vault-policy is open in another program (${code}); close it and try again — the marker was not changed`);
    assert.deepEqual(slept, [50, 100, 200, 400]);
  }
});

test('other errors, and any error off Windows, pass through at once', () => {
  const never = () => { throw new Error('slept'); };
  assert.throws(() => W.retryHeld(() => { throw err('ENOENT'); }, 'F', 'u', { windows: true, sleep: never }), e => e.code === 'ENOENT');
  assert.throws(() => W.retryHeld(() => { throw err('EPERM'); }, 'F', 'u', { windows: false, sleep: never }), e => e.message === 'raw EPERM');
});
