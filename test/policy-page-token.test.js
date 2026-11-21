'use strict';
// The Vault policies page in mode "token": served by the MCP HTTP handler under
// /private_<token>/policies.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const S = require('../src/server.js');
const H = require('../src/http.js');
const { createTokenPage } = require('../src/policy-page.js');
const { tmpDir } = require('./helpers.js');

const V = tmpDir();
fs.mkdirSync(path.join(V, 'notes'));
S.init(V);
const page = createTokenPage({ vault: V });

// Generated per run: a fixture, not a credential.
const TOKEN = crypto.randomBytes(32).toString('hex');
const WRONG = 'FAKE-wrong-token-0123456789abcdefghijk';
const PAGE = `/private_${TOKEN}/policies`;
const MARKER = path.join(V, 'notes', '.vault-policy');
const FORBIDDEN = { ok: false, error: 'Forbidden: the request did not come from this page' };
const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
const logs = [];
let server, port, bare, barePort;

test.before(async () => {
  server = http.createServer(H.createHttpHandler({ token: TOKEN, host: '127.0.0.1', policyPage: page, logRequests: true, log: m => logs.push(m) }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  bare = http.createServer(H.createHttpHandler({ token: TOKEN, host: '127.0.0.1', log: () => {} }));
  await new Promise(r => bare.listen(0, '127.0.0.1', r));
  barePort = bare.address().port;
});
test.after(() => Promise.all([new Promise(r => server.close(r)), new Promise(r => bare.close(r))]));

// A request with full control over the headers.
function request(method, p, { headers = {}, body, onPort = port } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: onPort, path: p, method, headers }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', c => (text += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)));
  });
}

const change = mode => ({ path: path.join(V, 'notes'), mode, trash: true, trashName: '.vault-trash', retention_enabled: false, retention_days: 30 });
const post = (body, headers) => request('POST', `${PAGE}/api/policy`, { headers: { 'content-type': 'application/json', ...headers }, body });
const ORIGIN = () => ({ origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` });

test('GET the page: HTML with the base, the token-mode note and the safety headers', async () => {
  for (const p of [PAGE, `${PAGE}/`]) {
    const r = await request('GET', p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers['content-type'], /^text\/html/);
    assert.ok(r.text.includes('<title>Vault policies</title>'));
    assert.ok(r.text.includes(`const BASE = "${PAGE}"`));
    assert.ok(r.text.includes("stops Everkeep's tools"));
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.ok(r.headers['content-security-policy'].includes("frame-ancestors 'none'"));
  }
});

test('GET api/tree: the vault and its directories', async () => {
  const r = await request('GET', `${PAGE}/api/tree`);
  assert.equal(r.status, 200);
  assert.equal(r.json.vault, V);
  assert.ok(r.json.children.some(c => c.name === 'notes'));
});

test('POST api/policy from the page: marker written with the token-mode preamble', async () => {
  const r = await post(change('rev'), ORIGIN());
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  const marker = JSON.parse(fs.readFileSync(MARKER, 'utf8'));
  assert.ok(marker._.includes('/policies in place of /mcp'));
});

test('POST without Origin or from another origin: 403, no marker change', async () => {
  const removed = await post(change('inherit'), ORIGIN());
  assert.equal(removed.status, 200, removed.text);
  assert.equal(fs.existsSync(MARKER), false);

  let r = await post(change('rev'), { host: `127.0.0.1:${port}` });
  assert.equal(r.status, 403);
  assert.match(r.headers['content-type'], /^application\/json/);
  assert.deepEqual(r.json, FORBIDDEN);
  assert.equal(fs.existsSync(MARKER), false);

  r = await post(change('rev'), { origin: 'http://evil.example', host: `127.0.0.1:${port}` });
  assert.equal(r.status, 403);
  assert.equal(fs.existsSync(MARKER), false);
});

test('wrong token: 404', async () => {
  assert.equal((await request('GET', `/private_${WRONG}/policies`)).status, 404);
  assert.equal((await request('GET', `/private_${TOKEN}x/policies`)).status, 404);
});

test('a handler without policyPage: the page is 404, /mcp still works', async () => {
  assert.equal((await request('GET', PAGE, { onPort: barePort })).status, 404);
  const r = await request('POST', `/private_${TOKEN}/mcp`, { onPort: barePort, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: LIST });
  assert.equal(r.status, 200, r.text);
  assert.ok(Array.isArray(r.json.result.tools));
});

test('/mcp on the main server: tools/list answers with 20 tools', async () => {
  const r = await request('POST', `/private_${TOKEN}/mcp`, { headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: LIST });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.result.tools.length, 20);
});

test('request log: the token is masked, page requests are noted', () => {
  assert.ok(logs.length > 0);
  assert.ok(logs.every(l => !l.includes(TOKEN)));
  assert.ok(logs.some(l => l.includes('/private_***/policies') && l.includes('(policy page)')));
});

test('authorize: page paths, a near miss and no Bearer form', () => {
  const req = (url, headers = {}) => ({ url, headers });
  assert.equal(H.authorize(req(PAGE), TOKEN), 'page');
  assert.equal(H.authorize(req(`${PAGE}/api/tree`), TOKEN), 'page');
  assert.equal(H.authorize(req(`/private_${TOKEN}/policiesx`), TOKEN), 'not_found');
  assert.equal(H.authorize(req('/policies', { authorization: `Bearer ${TOKEN}` }), TOKEN), 'not_found');
});
