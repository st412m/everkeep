'use strict';
// The auth front and the transport behind it.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const S = require('../src/server.js');
const H = require('../src/http.js');
const { tmpDir } = require('./helpers.js');

const V = tmpDir();
fs.writeFileSync(path.join(V, 'a.md'), 'hello\n');
S.init(V);

// Generated per run: a fixture, not a credential.
const TOKEN = crypto.randomBytes(32).toString('hex');
const WRONG = 'FAKE-wrong-token-0123456789abcdefghijk';
const logs = [];
let server, base, port;

test.before(async () => {
  // A localhost bind: Host/Origin checks on; log_requests on.
  server = http.createServer(H.createHttpHandler({ token: TOKEN, host: '127.0.0.1', logRequests: true, log: m => logs.push(m) }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});
test.after(() => new Promise(r => server.close(r)));

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } };
const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
const SECRET = () => `/private_${TOKEN}/mcp`;

async function rpc(p, body, headers = {}, method = 'POST') {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, headers: res.headers, text, json };
}

// Raw request, so Host and Origin can be set.
function raw(p, { host, origin, body = INIT } = {}, onPort = port) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    if (host) headers.host = host;
    if (origin) headers.origin = origin;
    const req = http.request({ host: '127.0.0.1', port: onPort, path: p, method: 'POST', headers }, res => {
      let text = '';
      res.on('data', c => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('authorize: secret path, Bearer on /mcp, everything else', () => {
  const req = (url, authorization) => ({ url, headers: authorization === undefined ? {} : { authorization } });
  assert.equal(H.authorize(req(`/private_${TOKEN}/mcp`), TOKEN), 'ok');
  assert.equal(H.authorize(req(`/private_${TOKEN}/mcp?x=1`), TOKEN), 'ok');
  assert.equal(H.authorize(req(`/private_${TOKEN}x/mcp`), TOKEN), 'not_found');
  assert.equal(H.authorize(req('/mcp', `Bearer ${TOKEN}`), TOKEN), 'ok');
  assert.equal(H.authorize(req('/mcp', `bearer ${TOKEN}`), TOKEN), 'ok');
  assert.equal(H.authorize(req('/mcp', 'Bearer wrong'), TOKEN), 'unauthorized');
  assert.equal(H.authorize(req('/mcp', `Basic ${TOKEN}`), TOKEN), 'unauthorized');
  assert.equal(H.authorize(req('/mcp'), TOKEN), 'not_found', 'no header on /mcp: not found, not 401');
  assert.equal(H.authorize(req(`/private_${TOKEN}/mcp`, 'Bearer wrong'), TOKEN), 'ok', 'the path alone is enough');
  assert.equal(H.authorize(req('/'), TOKEN), 'not_found');
  assert.equal(H.authorize(req(`/private_${TOKEN}/other`), TOKEN), 'not_found');
  assert.equal(H.authorize(req(`/.well-known/oauth-protected-resource/private_${TOKEN}/mcp`), TOKEN), 'not_found');
});

test('wrong path: bare 404 without WWW-Authenticate', async () => {
  for (const p of ['/', '/mcp', '/private_nope/mcp', `/private_${TOKEN}/`, `/private_${TOKEN}`, '/sse', `/private_${TOKEN}mcp`]) {
    const r = await rpc(p, INIT);
    assert.equal(r.status, 404, p);
    assert.equal(r.text, '', p);
    assert.equal(r.headers.get('www-authenticate'), null, p);
  }
});

test('/.well-known/* is 404, so clients never start OAuth', async () => {
  for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/openid-configuration']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 404, p);
    assert.equal(res.headers.get('www-authenticate'), null, p);
    assert.equal(await res.text(), '', p);
  }
});

test('wrong Bearer: 401 only when the header was sent, no WWW-Authenticate', async () => {
  for (const h of [`Bearer ${WRONG}`, 'Bearer', `Basic ${TOKEN}`]) {
    const r = await rpc('/mcp', INIT, { authorization: h });
    assert.equal(r.status, 401, h);
    assert.equal(r.text, '');
    assert.equal(r.headers.get('www-authenticate'), null);
  }
});

test('secret path and Bearer both reach MCP; serverInfo is everkeep', async () => {
  for (const [p, h] of [[SECRET(), {}], ['/mcp', { authorization: `Bearer ${TOKEN}` }]]) {
    const r = await rpc(p, INIT, h);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.result.serverInfo.name, 'everkeep');
    assert.equal(r.json.result.serverInfo.version, require('../package.json').version);
    assert.equal(r.json.result.protocolVersion, '2025-06-18');
    assert.equal(r.headers.get('mcp-session-id'), null, 'no sessions');
    const l = await rpc(p, LIST, { ...h, 'mcp-protocol-version': '2025-06-18' });
    assert.equal(l.json.result.tools.length, 20);
  }
});

test('2.9.0 transport behind the front: GET 405, OPTIONS 204 with CORS, 406, Bad JSON, 202, batch', async () => {
  let r = await rpc(SECRET(), null, {}, 'GET');
  assert.equal(r.status, 405);
  assert.equal(r.headers.get('allow'), 'POST, OPTIONS');

  r = await rpc(SECRET(), null, {}, 'OPTIONS');
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.equal(r.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS, DELETE');
  assert.equal(r.headers.get('access-control-allow-headers'), 'Content-Type, Accept, mcp-session-id, mcp-protocol-version');

  r = await rpc(SECRET(), LIST, { accept: 'text/html' });
  assert.equal(r.status, 406);
  assert.equal(r.text, '{"error":"Not Acceptable: Client must accept application/json or text/event-stream"}');

  r = await rpc(SECRET(), '{not json');
  assert.equal(r.status, 400);
  assert.equal(r.text, 'Bad JSON');

  r = await rpc(SECRET(), { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(r.status, 202);
  assert.equal(r.text, '');

  r = await rpc(SECRET(), [{ jsonrpc: '2.0', id: 7, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 8, method: 'nope' }]);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, [{ jsonrpc: '2.0', id: 7, result: {} }, { jsonrpc: '2.0', id: 8, error: { code: -32601, message: 'Method not found: nope' } }]);
});

test('localhost bind: a foreign Host or Origin is refused with 403', async () => {
  const p = SECRET();
  assert.equal((await raw(p)).status, 200, 'local Host passes');
  assert.equal((await raw(p, { host: `localhost:${port}` })).status, 200);
  assert.equal((await raw(p, { host: `[::1]:${port}` })).status, 200);
  const h = await raw(p, { host: 'evil.example.com' });
  assert.equal(h.status, 403);
  assert.equal(h.text, '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Invalid Host: evil.example.com"},"id":null}');
  assert.equal((await raw(p, { host: 'localhost.evil.example.com' })).status, 403);
  const o = await raw(p, { origin: 'https://evil.example.com' });
  assert.equal(o.status, 403);
  assert.equal(o.text, '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Invalid Origin: evil.example.com"},"id":null}');
  assert.equal((await raw(p, { origin: 'null' })).status, 403);
  assert.equal((await raw(p, { origin: `http://localhost:${port}` })).status, 200);
  assert.equal((await raw('/nope', { host: 'evil.example.com' })).status, 404, 'a wrong path is still a bare 404');
});

test('non-local bind: no Host/Origin checks, the token alone protects', async () => {
  const open = http.createServer(H.createHttpHandler({ token: TOKEN, host: '0.0.0.0', log: () => {} }));
  await new Promise(r => open.listen(0, '127.0.0.1', r));
  try {
    const p2 = open.address().port;
    assert.equal((await raw(SECRET(), { host: 'mcp.example.com', origin: 'https://claude.ai' }, p2)).status, 200);
    assert.equal((await raw('/private_nope/mcp', { host: 'mcp.example.com' }, p2)).status, 404);
  } finally {
    await new Promise(r => open.close(r));
  }
  for (const h of ['127.0.0.1', 'localhost', '::1', 'LOCALHOST']) assert.equal(H.isLocalBind(h), true, h);
  for (const h of ['0.0.0.0', '::', '192.0.2.10']) assert.equal(H.isLocalBind(h), false, h);
  assert.equal(H.bindNote(true), '');
  assert.equal(H.bindNote(false), ' — non-local bind: no Host/Origin checks, the token alone protects the server');
});

// A handler on its own port; returns [port, close].
async function listenWith(opts) {
  const srv = http.createServer(H.createHttpHandler({ token: TOKEN, log: () => {}, ...opts }));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return [srv.address().port, () => new Promise(r => srv.close(r))];
}

test('allowed_hosts on a localhost bind: a listed name passes in Host and Origin, others still get 403', async () => {
  const [p2, close] = await listenWith({ host: '127.0.0.1', allowedHosts: ['Notes.Example.TS.net', '[2001:DB8:0::1]'] });
  try {
    const p = SECRET();
    assert.equal((await raw(p, { host: 'notes.example.ts.net' }, p2)).status, 200, 'listed name in Host');
    assert.equal((await raw(p, { host: 'NOTES.example.ts.net:443' }, p2)).status, 200, 'letter case and a port do not matter');
    assert.equal((await raw(p, { host: '[2001:db8::1]:8443' }, p2)).status, 200, 'IPv6, compared in its short form');
    assert.equal((await raw(p, { host: 'localhost', origin: 'https://notes.example.ts.net' }, p2)).status, 200, 'listed name in Origin');
    assert.equal((await raw(p, { host: 'notes.example.ts.net', origin: 'https://Notes.Example.ts.net:8443' }, p2)).status, 200);
    assert.equal((await raw(p, { host: `localhost:${p2}` }, p2)).status, 200, 'localhost still passes');
    const h = await raw(p, { host: 'evil.example.com' }, p2);
    assert.equal(h.status, 403);
    assert.equal(h.text, '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Invalid Host: evil.example.com"},"id":null}');
    assert.equal((await raw(p, { host: 'notes.example.ts.net.evil.example.com' }, p2)).status, 403, 'a name that only starts with a listed one');
    assert.equal((await raw(p, { host: 'notes.example.ts.net', origin: 'https://evil.example.com' }, p2)).status, 403, 'listed Host, foreign Origin');
    assert.equal((await raw('/private_nope/mcp', { host: 'notes.example.ts.net' }, p2)).status, 404, 'the token is still required');
  } finally {
    await close();
  }
  assert.deepEqual(H.allowedHostnames(['Notes.Example.TS.net', '[2001:DB8:0::1]']), ['notes.example.ts.net', '[2001:db8::1]']);
});

test('allowed_hosts on a non-local bind changes nothing: there are no checks to relax', async () => {
  const [p2, close] = await listenWith({ host: '0.0.0.0', allowedHosts: ['notes.example.ts.net'] });
  try {
    assert.equal((await raw(SECRET(), { host: 'evil.example.com', origin: 'https://evil.example.com' }, p2)).status, 200);
    assert.equal((await raw('/private_nope/mcp', { host: 'notes.example.ts.net' }, p2)).status, 404);
  } finally {
    await close();
  }
});

test('log lines: never the token; log_requests masks it in the path', async () => {
  logs.length = 0;
  await rpc('/mcp', INIT, { authorization: `Bearer ${WRONG}` });
  await rpc(SECRET(), INIT, { 'user-agent': 'ua-test' });
  await rpc('/mcp', INIT, { authorization: `Bearer ${TOKEN}` });
  await rpc(`/private_${WRONG}/mcp`, INIT);
  await new Promise(r => setTimeout(r, 50));
  assert.ok(logs.includes('everkeep: http POST 401 (wrong bearer token)'), logs.join('\n'));
  for (const l of logs) {
    assert.ok(!l.includes(TOKEN), l);
    assert.ok(!l.includes(WRONG), l);
  }
  const req = logs.filter(l => l.startsWith('[req] '));
  assert.equal(req.length, 4, logs.join('\n'));
  assert.match(req[0], /^\[req\] \d{4}-\d\d-\d\dT[\d:.]+Z \S+ POST \/mcp -> 401 0B pv=- ua="[^"]*" \(unauthorized\)$/);
  assert.match(req[1], /^\[req\] \S+ \S+ POST \/private_\*\*\*\/mcp -> 200 \d+B pv=- ua="ua-test"$/);
  assert.match(req[2], /^\[req\] \S+ \S+ POST \/mcp -> 200 \d+B pv=- ua="[^"]*"$/);
  assert.match(req[3], /^\[req\] \S+ \S+ POST \/private_\*\*\*\/mcp -> 404 0B pv=- ua="[^"]*" \(not found\)$/);
});

test('without log_requests only refusals are logged, without paths', async () => {
  const quiet = [];
  const srv = http.createServer(H.createHttpHandler({ token: TOKEN, log: m => quiet.push(m) }));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const u = `http://127.0.0.1:${srv.address().port}`;
    await fetch(u + SECRET(), { method: 'POST', headers: { accept: 'application/json' }, body: JSON.stringify(INIT) });
    await fetch(u + '/nope', { method: 'POST', body: '{}' });
    await fetch(u + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${WRONG}` }, body: '{}' });
  } finally {
    await new Promise(r => srv.close(r));
  }
  assert.deepEqual(quiet, ['everkeep: http POST 401 (wrong bearer token)']);
});

test('maskPath', () => {
  assert.equal(H.maskPath(`/private_${TOKEN}/mcp`), '/private_***/mcp');
  assert.equal(H.maskPath(`/private_${TOKEN}/mcp?x=/private_abc`), '/private_***/mcp?x=/private_***');
  assert.equal(H.maskPath('/x'.repeat(100)).length, 120);
});
