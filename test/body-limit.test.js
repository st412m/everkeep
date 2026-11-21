'use strict';
// Body limit on the MCP endpoint and the policy page.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

// Read when policy-page.js is loaded.
process.env.ALLOW_LOCAL = 'true';
const S = require('../src/server.js');
const H = require('../src/http.js');
const { createPolicyPage } = require('../src/policy-page.js');
const { tmpDir } = require('./helpers.js');

const V = tmpDir();
fs.writeFileSync(path.join(V, 'a.md'), 'hello\n');
S.init(V);

// Generated per run: a fixture, not a credential.
const TOKEN = crypto.randomBytes(32).toString('hex');
const WRONG = 'FAKE-wrong-token-0123456789abcdefghijk';
const logs = [];
let server, port, page, pagePort;

test.before(async () => {
  server = http.createServer(H.createHttpHandler({ token: TOKEN, host: '127.0.0.1', maxBodyBytes: 1024, logRequests: true, log: m => logs.push(m) }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  page = createPolicyPage({ vault: V, users: [] });
  await new Promise(r => page.listen(0, '127.0.0.1', r));
  pagePort = page.address().port;
});
test.after(() => Promise.all([new Promise(r => server.close(r)), new Promise(r => page.close(r))]));

const SECRET = `/private_${TOKEN}/mcp`;
const LIST = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
const padded = n => LIST + ' '.repeat(n - LIST.length);

// Resolves once the response has ended and the connection has closed.
function post(p, body, { headers = {}, chunked = false, onPort = port } = {}) {
  return new Promise((resolve, reject) => {
    const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers };
    if (!chunked) h['content-length'] = String(Buffer.byteLength(body));
    let out = null, closed = false;
    const done = () => { if (out && closed) resolve(out); };
    const req = http.request({ host: '127.0.0.1', port: onPort, path: p, method: 'POST', agent: false, headers: h }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', c => (text += c));
      res.on('end', () => { out = { status: res.statusCode, headers: res.headers, text }; done(); });
    });
    req.on('error', reject);
    req.on('close', () => { closed = true; done(); });
    if (chunked) {
      const buf = Buffer.from(body);
      for (let i = 0; i < buf.length; i += 512) req.write(buf.subarray(i, i + 512));
    } else {
      req.write(body);
    }
    req.end();
  });
}

test('secret path, Content-Length 2048: 413 with a JSON-RPC error, logged', async () => {
  const r = await post(SECRET, padded(2048));
  assert.equal(r.status, 413);
  assert.equal(r.headers.connection, 'close');
  assert.equal(r.headers['access-control-allow-origin'], '*');
  const j = JSON.parse(r.text);
  assert.equal(j.error.code, -32600);
  assert.match(j.error.message, /limit 1024 bytes/);
  assert.match(j.error.message, /edit_file/);
  assert.ok(logs.some(l => l.includes('413 (body too large)')), logs.join('\n'));
  assert.ok(logs.some(l => l.startsWith('[req]') && l.includes('(too large)')), logs.join('\n'));
});

test('Bearer on /mcp, chunked 2048 bytes: 413', async () => {
  const r = await post('/mcp', padded(2048), { headers: { authorization: `Bearer ${TOKEN}` }, chunked: true });
  assert.equal(r.status, 413);
});

test('tools/list of exactly the limit: 200 with 20 tools', async () => {
  const r = await post(SECRET, padded(1024));
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.text).result.tools.length, 20);
});

test('oversized body without a valid token: 404 / 404 / 401, never 413', async () => {
  const from = logs.length;
  assert.equal((await post('/mcp', padded(2048))).status, 404);
  assert.equal((await post(`/private_${WRONG}/mcp`, padded(2048))).status, 404);
  assert.equal((await post('/mcp', padded(2048), { headers: { authorization: `Bearer ${WRONG}` } })).status, 401);
  const added = logs.slice(from);
  assert.ok(!added.some(l => /-> 413 |413 \(body too large\)/.test(l)), added.join('\n'));
});

test('invalid JSON: 400 Bad JSON', async () => {
  const r = await post(SECRET, '{not json}');
  assert.equal(r.status, 400);
  assert.equal(r.text, 'Bad JSON');
});

test('a normal tools/list still gets 200', async () => {
  const r = await post(SECRET, LIST);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(JSON.parse(r.text).result.tools));
});

test('a throw outside the try in transport answers 500 and the server keeps serving', async () => {
  const other = http.createServer(H.createHttpHandler({ token: TOKEN, host: '127.0.0.1', maxBodyBytes: 1024, logRequests: false, log: () => { throw new Error('log failed'); } }));
  await new Promise(r => other.listen(0, '127.0.0.1', r));
  const otherPort = other.address().port;
  try {
    const r = await post(SECRET, padded(2048), { onPort: otherPort });
    assert.equal(r.status, 500);
    assert.equal(JSON.parse(r.text).error.code, -32603);
    const ok = await post(SECRET, LIST, { onPort: otherPort });
    assert.equal(ok.status, 200);
  } finally {
    await new Promise(r => other.close(r));
  }
});

test('policy page: a 2 MiB POST /api/policy gets 413', async () => {
  const r = await post('/api/policy', 'x'.repeat(2 * 1024 * 1024), { onPort: pagePort });
  assert.equal(r.status, 413);
  assert.equal(r.headers.connection, 'close');
  const j = JSON.parse(r.text);
  assert.equal(j.ok, false);
  assert.match(j.error, /limit 1048576 bytes/);
});

test('policy page: bad JSON still gets 400', async () => {
  const r = await post('/api/policy', '{', { onPort: pagePort });
  assert.equal(r.status, 400);
  assert.equal(JSON.parse(r.text).ok, false);
});
