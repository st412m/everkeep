'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const T = require('../src/token.js');
const H = require('../src/http.js');
const { tmpDir } = require('./helpers.js');

const POSIX = process.platform !== 'win32' ? false : 'POSIX file modes';

// Fixtures: obviously fake values.
const GOOD = 'FAKE-token-for-tests-0123456789abcdefghijk';
const SHORT = 'FAKE-short';

test('token rules: at least 32 chars of A-Z a-z 0-9 . _ ~ -; messages never echo the token', () => {
  assert.equal(H.validateToken(GOOD), GOOD);
  assert.equal(H.validateToken('a'.repeat(32)), 'a'.repeat(32));
  const bad = [
    ['', /the token is empty/],
    [SHORT, /the token is too short: 10 chars, at least 32 required/],
    ['FAKE/with/slashes/0123456789abcdefghijkl', /may contain only A-Z a-z 0-9 \. _ ~ -/],
    ['FAKE with spaces 0123456789abcdefghijklmn', /may contain only/],
  ];
  for (const [t, re] of bad)
    assert.throws(() => H.validateToken(t), err => re.test(err.message) && !(t && err.message.includes(t)), t);
  assert.equal(H.sameSecret(GOOD, GOOD), true);
  assert.equal(H.sameSecret('x', GOOD), false);
});

test('a token is generated once: 64 hex chars, saved, then reused', () => {
  const dir = tmpDir();
  const a = T.resolveToken({ env: {}, stateDir: dir });
  assert.equal(a.generated, true);
  assert.match(a.token, /^[0-9a-f]{64}$/);
  assert.equal(a.file, path.join(dir, 'token'));
  assert.equal(fs.readFileSync(a.file, 'utf8'), a.token + '\n');
  assert.deepEqual(fs.readdirSync(dir), ['token'], 'no temp file left behind');

  const b = T.resolveToken({ env: {}, stateDir: dir });
  assert.equal(b.generated, false);
  assert.equal(b.token, a.token);
  assert.equal(b.source, a.file);
});

test('the saved token has mode 0600', { skip: POSIX }, () => {
  const dir = tmpDir();
  const a = T.resolveToken({ env: {}, stateDir: dir });
  assert.equal(fs.statSync(a.file).mode & 0o777, 0o600);
  T.replaceToken(dir);
  assert.equal(fs.statSync(a.file).mode & 0o777, 0o600);
});

test('replaceToken (`everkeep token --new`) writes a different token over the old one', () => {
  const dir = tmpDir();
  const a = T.resolveToken({ env: {}, stateDir: dir });
  const n = T.replaceToken(dir);
  assert.notEqual(n.token, a.token);
  assert.match(n.token, /^[0-9a-f]{64}$/);
  assert.equal(T.resolveToken({ env: {}, stateDir: dir }).token, n.token);
  assert.deepEqual(fs.readdirSync(dir), ['token']);
});

test('order: --token-file, then env EVERKEEP_TOKEN, then the saved token', () => {
  const dir = tmpDir();
  const saved = T.resolveToken({ env: {}, stateDir: dir }).token;
  const tf = path.join(dir, 'given.txt');
  fs.writeFileSync(tf, `${GOOD}x\n`);
  const env = { EVERKEEP_TOKEN: GOOD };
  assert.deepEqual(T.resolveToken({ tokenFile: tf, env, stateDir: dir }), { token: `${GOOD}x`, source: '--token-file', generated: false, legacy: false, file: null });
  assert.equal(T.resolveToken({ env, stateDir: dir }).token, GOOD);
  assert.equal(T.resolveToken({ env, stateDir: dir }).source, 'env EVERKEEP_TOKEN');
  assert.equal(T.resolveToken({ env: { EVERKEEP_TOKEN: '' }, stateDir: dir }).token, saved);
});

test('a given token that breaks the rules refuses to start, with the hint, never echoing it', () => {
  const dir = tmpDir();
  for (const env of [{ EVERKEEP_TOKEN: SHORT }, { EVERKEEP_TOKEN: SHORT, EVERKEEP_ALLOW_LEGACY_TOKEN: '1' }]) {
    assert.throws(() => T.resolveToken({ env, stateDir: dir }), err => {
      assert.equal(err.name, 'TokenError');
      assert.equal(err.message, 'token from env EVERKEEP_TOKEN: the token is too short: 10 chars, at least 32 required; run `everkeep token --new` for a generated one');
      return true;
    });
  }
  const tf = path.join(dir, 'given.txt');
  fs.writeFileSync(tf, 'FAKE-short-2\n');
  assert.throws(() => T.resolveToken({ tokenFile: tf, env: {}, stateDir: dir }), err => !err.message.includes('FAKE-short-2') && /--token-file/.test(err.message));
  assert.throws(() => T.resolveToken({ tokenFile: path.join(dir, 'nope'), env: {}, stateDir: dir }), /cannot read --token-file \(ENOENT\)/);
  assert.equal(fs.existsSync(path.join(dir, 'token')), false, 'nothing generated when a given token is refused');
});

test('legacy switch: honoured only with SUPERVISOR_TOKEN set (inside Home Assistant)', () => {
  const dir = tmpDir();
  const legacy = 'changeme';
  assert.throws(() => T.resolveToken({ env: { EVERKEEP_TOKEN: legacy, EVERKEEP_ALLOW_LEGACY_TOKEN: '1' }, stateDir: dir }), /too short/);
  assert.throws(() => T.resolveToken({ env: { EVERKEEP_TOKEN: legacy, SUPERVISOR_TOKEN: 'FAKE-supervisor' }, stateDir: dir }), /too short/);
  assert.throws(() => T.resolveToken({ env: { EVERKEEP_TOKEN: legacy, EVERKEEP_ALLOW_LEGACY_TOKEN: 'true', SUPERVISOR_TOKEN: 'FAKE-supervisor' }, stateDir: dir }), /too short/);
  const r = T.resolveToken({ env: { EVERKEEP_TOKEN: legacy, EVERKEEP_ALLOW_LEGACY_TOKEN: '1', SUPERVISOR_TOKEN: 'FAKE-supervisor' }, stateDir: dir });
  assert.deepEqual(r, { token: legacy, source: 'env EVERKEEP_TOKEN', generated: false, legacy: true, file: null });
  // An HTTP handler accepts it only when told so.
  assert.throws(() => H.createHttpHandler({ token: legacy }), /too short/);
  assert.doesNotThrow(() => H.createHttpHandler({ token: legacy, legacyToken: true }));
});

test('a saved token that breaks the rules is refused too', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'token'), 'FAKE-edited\n');
  assert.throws(() => T.resolveToken({ env: {}, stateDir: dir }), err => err.message.startsWith(`token in ${path.join(dir, 'token')}: the token is too short`) && !err.message.includes('FAKE-edited'));
});

test('generate: false never creates a token', () => {
  const dir = tmpDir();
  assert.throws(() => T.resolveToken({ env: {}, stateDir: dir, generate: false }), /^TokenError: no token yet: `everkeep serve` generates one on its first start, or run `everkeep token --new` for a generated one$/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('connection lines', () => {
  assert.deepEqual(T.connectionLines(GOOD), [`/private_${GOOD}/mcp`, `Authorization: Bearer ${GOOD}`]);
});
