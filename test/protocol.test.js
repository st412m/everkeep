'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const S = require('../src/server.js');
const H = require('../src/http.js');

const V = fs.mkdtempSync(path.join(os.tmpdir(), 'everkeep-protocol-'));
S.init(V);
test.after(() => fs.rmSync(V, { recursive: true, force: true }));

// Generated per run: a fixture, not a credential.
const TOKEN = crypto.randomBytes(32).toString('hex');

const UNSUPPORTED = 'Supported: 2025-06-18, 2025-03-26, 2024-11-05';

async function initialize(protocolVersion) {
  const params = protocolVersion === undefined ? {} : { protocolVersion };
  const r = await S.handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params });
  return r.result.protocolVersion;
}

test('supported versions', () => {
  assert.deepEqual(S.SUPPORTED_PROTOCOL_VERSIONS, ['2025-06-18', '2025-03-26', '2024-11-05']);
});

test('initialize echoes a supported version, otherwise answers 2025-06-18', async () => {
  assert.equal(await initialize('2025-06-18'), '2025-06-18');
  assert.equal(await initialize('2025-03-26'), '2025-03-26');
  assert.equal(await initialize('2024-11-05'), '2024-11-05');
  assert.equal(await initialize('2099-01-01'), '2025-06-18');
  assert.equal(await initialize(undefined), '2025-06-18');
  const r = await S.handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.equal(r.result.protocolVersion, '2025-06-18');
  assert.deepEqual(r.result.capabilities, { tools: { listChanged: false } });
});

const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };

test('MCP-Protocol-Version: absent or supported passes', () => {
  assert.equal(H.protocolHeaderError([], LIST), null);
  assert.equal(H.protocolHeaderError(['Accept', 'application/json'], LIST), null);
  for (const v of S.SUPPORTED_PROTOCOL_VERSIONS) {
    assert.equal(H.protocolHeaderError(['MCP-Protocol-Version', v], LIST), null, v);
    assert.equal(H.protocolHeaderError(['mcp-protocol-version', v], LIST), null, v);
  }
});

test('MCP-Protocol-Version: unsupported, empty or repeated is refused', () => {
  const bad = [
    ['MCP-Protocol-Version', '2099-01-01'],
    ['MCP-Protocol-Version', ''],
    ['MCP-Protocol-Version', '2025-06-18', 'mcp-protocol-version', '2025-06-18'],
  ];
  for (const h of bad) {
    const e = H.protocolHeaderError(h, LIST);
    assert.ok(e, JSON.stringify(h));
    assert.equal(e.jsonrpc, '2.0');
    assert.equal(e.id, null);
    assert.equal(e.error.code, -32600);
    assert.ok(e.error.message.endsWith(`. ${UNSUPPORTED}`), e.error.message);
  }
  assert.equal(H.protocolHeaderError(bad[0], LIST).error.message,
    `Unsupported MCP-Protocol-Version: 2099-01-01. ${UNSUPPORTED}`);
  assert.equal(H.protocolHeaderError(bad[1], LIST).error.message,
    `Unsupported MCP-Protocol-Version: . ${UNSUPPORTED}`);
});

test('MCP-Protocol-Version: the echoed value is cut to 40 characters', () => {
  const e = H.protocolHeaderError(['MCP-Protocol-Version', 'x'.repeat(100)], LIST);
  assert.equal(e.error.message, `Unsupported MCP-Protocol-Version: ${'x'.repeat(40)}. ${UNSUPPORTED}`);
});

test('MCP-Protocol-Version: initialize is never checked, alone or in a batch', () => {
  const bad = [
    ['MCP-Protocol-Version', '2099-01-01'],
    ['MCP-Protocol-Version', ''],
    ['MCP-Protocol-Version', '2025-06-18', 'mcp-protocol-version', '2025-06-18'],
  ];
  for (const h of bad) {
    assert.equal(H.protocolHeaderError(h, INIT), null);
    assert.equal(H.protocolHeaderError(h, [INIT, LIST]), null);
    assert.ok(H.protocolHeaderError(h, [LIST]));
  }
});

test('MCP-Protocol-Version: a body that is not an object does not throw', () => {
  for (const body of [null, [null], 1, 'x', [], [[]]]) {
    assert.equal(H.protocolHeaderError([], body), null);
    assert.ok(H.protocolHeaderError(['MCP-Protocol-Version', '2099-01-01'], body));
  }
});

test('a request that is not an object gets -32600 with id null', async () => {
  for (const body of [null, 1, 'x', [], true]) {
    const r = await S.handleMcpRequest(body);
    assert.equal(r.id, null);
    assert.equal(r.error.code, -32600);
  }
});

test('Accept', () => {
  for (const h of ['*/*', 'application/*', 'application/json;q=0.9, text/html', 'text/event-stream',
                   'application/json', 'TEXT/Event-Stream', 'text/html, */*;q=0.1'])
    assert.equal(H.acceptsMcp(h), true, h);
  for (const h of ['text/html', '', undefined, 'text/*', 'application/xml'])
    assert.equal(H.acceptsMcp(h), false, String(h));
});

// --- over HTTP ----------------------------------------------------------------

// Through the secret path, as the 2.9.0 proxy forwarded it to /mcp.
async function withServer(fn) {
  const server = http.createServer(H.createHttpHandler({ token: TOKEN, host: '127.0.0.1', log: () => {} }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/private_${TOKEN}/mcp`;
  try { await fn(url); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function post(url, body, headers) {
  return fetch(url, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json', 'Accept': 'application/json' }, headers || {}),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('HTTP: null and [null] get -32600 and the server keeps answering', async () => {
  await withServer(async url => {
    let r = await post(url, 'null');
    assert.equal(r.status, 200);
    assert.equal((await r.json()).error.code, -32600);
    r = await post(url, '[null]');
    assert.equal(r.status, 200);
    const arr = await r.json();
    assert.equal(arr.length, 1);
    assert.equal(arr[0].error.code, -32600);
    r = await post(url, LIST);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).result.tools.length, 20);
  });
});

test('HTTP: Accept', async () => {
  await withServer(async url => {
    assert.equal((await post(url, LIST, { 'Accept': '*/*' })).status, 200);
    assert.equal((await post(url, LIST, { 'Accept': 'application/*' })).status, 200);
    const r = await post(url, LIST, { 'Accept': 'text/html' });
    assert.equal(r.status, 406);
    assert.equal(await r.text(), '{"error":"Not Acceptable: Client must accept application/json or text/event-stream"}');
  });
});

test('HTTP: MCP-Protocol-Version', async () => {
  await withServer(async url => {
    assert.equal((await post(url, LIST)).status, 200);
    assert.equal((await post(url, LIST, { 'MCP-Protocol-Version': '2025-06-18' })).status, 200);
    assert.equal((await post(url, LIST, { 'MCP-Protocol-Version': '2024-11-05' })).status, 200);

    const r = await post(url, LIST, { 'MCP-Protocol-Version': '2099-01-01' });
    assert.equal(r.status, 400);
    assert.equal(r.headers.get('content-type'), 'application/json');
    assert.equal(await r.text(),
      '{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Unsupported MCP-Protocol-Version: 2099-01-01. Supported: 2025-06-18, 2025-03-26, 2024-11-05"}}');

    const i = await post(url, INIT, { 'MCP-Protocol-Version': '2099-01-01' });
    assert.equal(i.status, 200);
    assert.equal((await i.json()).result.protocolVersion, '2025-06-18');
  });
});
