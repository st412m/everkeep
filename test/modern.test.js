'use strict';
// Protocol 2026-07-28 next to the legacy revisions: per-request _meta, no
// initialize, server/discover, HTTP header mirroring, status codes.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { PassThrough } = require('stream');
const S = require('../src/server.js');
const H = require('../src/http.js');
const { serveStdio } = require('../src/stdio.js');
const { tmpDir } = require('./helpers.js');

const V = tmpDir();
fs.writeFileSync(path.join(V, 'a.md'), 'hello\n');
S.init(V);
const { VERSION } = require('../src/version.js');

// Generated per run: a fixture, not a credential.
const TOKEN = crypto.randomBytes(32).toString('hex');

const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 't', version: '0' },
};
const SERVER_INFO = { 'io.modelcontextprotocol/serverInfo': { name: 'everkeep', version: VERSION } };
const req = (id, method, params = {}, meta = META) => ({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } });

// --- dispatcher ---------------------------------------------------------------

test('server/discover: supported versions, tools capability, serverInfo, cache hints', async () => {
  const r = await S.handleMcpRequest(req(1, 'server/discover'));
  assert.deepEqual(r, { jsonrpc: '2.0', id: 1, result: {
    resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} },
    ttlMs: 0, cacheScope: 'private', _meta: SERVER_INFO,
  } });
});

test('tools/list and tools/call carry resultType and serverInfo', async () => {
  const l = await S.handleMcpRequest(req(2, 'tools/list'));
  assert.equal(l.result.resultType, 'complete');
  assert.equal(l.result.tools.length, 20);
  assert.equal(l.result.ttlMs, 0);
  assert.equal(l.result.cacheScope, 'private');
  assert.deepEqual(l.result._meta, SERVER_INFO);
  const c = await S.handleMcpRequest(req(3, 'tools/call', { name: 'read_text_file', arguments: { path: path.join(V, 'a.md') } }));
  assert.deepEqual(c.result, { resultType: 'complete', content: [{ type: 'text', text: 'hello\n' }], _meta: SERVER_INFO });
  const e = await S.handleMcpRequest(req(4, 'tools/call', { name: 'nope', arguments: {} }));
  assert.equal(e.result.isError, true);
  assert.equal(e.result.resultType, 'complete');
});

test('envelope: missing version or capabilities -32602, unknown version -32022 with the supported list', async () => {
  let r = await S.handleMcpRequest(req(5, 'tools/list', {}, { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' }));
  assert.deepEqual(r.error, { code: -32602, message: 'Invalid params: _meta "io.modelcontextprotocol/clientCapabilities" is required' });
  r = await S.handleMcpRequest({ jsonrpc: '2.0', id: 6, method: 'server/discover' });
  assert.deepEqual(r.error, { code: -32602, message: 'Invalid params: _meta "io.modelcontextprotocol/protocolVersion" is required' });
  r = await S.handleMcpRequest(req(7, 'tools/list', {}, { ...META, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' }));
  assert.deepEqual(r, { jsonrpc: '2.0', id: 7, error: { code: -32022, message: 'Unsupported protocol version: 2099-01-01', data: { supported: ['2026-07-28'], requested: '2099-01-01' } } });
});

test('methods of the old revisions are not found in 2026-07-28; notifications get no answer', async () => {
  for (const m of ['ping', 'initialize', 'resources/list', 'prompts/list', 'logging/setLevel', 'subscriptions/listen']) {
    const r = await S.handleMcpRequest(req(8, m));
    assert.deepEqual(r.error, { code: -32601, message: `Method not found: ${m}` }, m);
  }
  assert.equal(await S.handleMcpRequest({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1, _meta: META } }), null);
  assert.equal(await S.handleMcpRequest({ jsonrpc: '2.0', method: 'notifications/whatever' }), null);
});

test('a legacy request is unchanged: no resultType, no _meta', async () => {
  const r = await S.handleMcpRequest({ jsonrpc: '2.0', id: 9, method: 'tools/list' });
  assert.equal(r.result.resultType, undefined);
  assert.equal(r.result._meta, undefined);
  assert.deepEqual(await S.handleMcpRequest({ jsonrpc: '2.0', id: 10, method: 'ping' }), { jsonrpc: '2.0', id: 10, result: {} });
});

// --- header helpers ------------------------------------------------------------

test('Mcp-Name base64 sentinel', () => {
  assert.equal(H.decodeHeaderValue('read_text_file'), 'read_text_file');
  assert.equal(H.decodeHeaderValue('=?base64?' + Buffer.from('чтение').toString('base64') + '?='), 'чтение');
  assert.equal(H.decodeHeaderValue('=?base64?not base64?='), null);
  assert.equal(H.decodeHeaderValue('=?base64?abc'), null);
});

// --- over HTTP ------------------------------------------------------------------

async function withServer(fn) {
  const server = http.createServer(H.createHttpHandler({ token: TOKEN, host: '127.0.0.1', log: () => {} }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/private_${TOKEN}/mcp`;
  try { await fn(url); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

async function post(url, body, headers = {}) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, type: r.headers.get('content-type'), text, json: text ? JSON.parse(text) : null };
}

const HDR = (method, name) => ({ 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method, ...(name === undefined ? {} : { 'Mcp-Name': name }) });

test('HTTP: discover, tools/list, tools/call → 200 JSON', async () => {
  await withServer(async url => {
    let r = await post(url, req(1, 'server/discover'), HDR('server/discover'));
    assert.equal(r.status, 200);
    assert.equal(r.type, 'application/json');
    assert.deepEqual(r.json.result.supportedVersions, ['2026-07-28']);
    r = await post(url, req(2, 'tools/list'), HDR('tools/list'));
    assert.equal(r.status, 200);
    assert.equal(r.json.result.tools.length, 20);
    r = await post(url, req(3, 'tools/call', { name: 'read_text_file', arguments: { path: path.join(V, 'a.md') } }), HDR('tools/call', 'read_text_file'));
    assert.equal(r.status, 200);
    assert.equal(r.json.result.content[0].text, 'hello\n');
    const b64 = '=?base64?' + Buffer.from('read_text_file').toString('base64') + '?=';
    r = await post(url, req(4, 'tools/call', { name: 'read_text_file', arguments: { path: path.join(V, 'a.md') } }), HDR('tools/call', b64));
    assert.equal(r.status, 200, r.text);
  });
});

test('HTTP: unknown method 404 -32601; envelope errors 400', async () => {
  await withServer(async url => {
    let r = await post(url, req(5, 'ping'), HDR('ping'));
    assert.equal(r.status, 404);
    assert.equal(r.json.error.code, -32601);
    r = await post(url, req(6, 'tools/list', {}, { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' }), HDR('tools/list'));
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, -32602);
    r = await post(url, req(7, 'tools/list', {}, { ...META, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' }), { ...HDR('tools/list'), 'MCP-Protocol-Version': '2099-01-01' });
    assert.equal(r.status, 400);
    assert.deepEqual(r.json.error.data, { supported: ['2026-07-28'], requested: '2099-01-01' });
    // A 2026-07-28 header without _meta in the body.
    r = await post(url, { jsonrpc: '2.0', id: 8, method: 'tools/list' }, { 'MCP-Protocol-Version': '2026-07-28' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, -32602);
  });
});

test('HTTP: headers that are missing, repeated or disagree with the body → 400 -32020', async () => {
  await withServer(async url => {
    const call = req(9, 'tools/call', { name: 'read_text_file', arguments: { path: path.join(V, 'a.md') } });
    const cases = [
      [{ 'Mcp-Method': 'tools/call', 'Mcp-Name': 'read_text_file' }, 'Header mismatch: the required MCP-Protocol-Version header is missing'],
      [{ ...HDR('tools/call', 'read_text_file'), 'MCP-Protocol-Version': '2025-06-18' }, "Header mismatch: MCP-Protocol-Version header value '2025-06-18' does not match body protocol version '2026-07-28'"],
      [{ 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Name': 'read_text_file' }, 'Header mismatch: the required Mcp-Method header is missing'],
      [HDR('tools/list', 'read_text_file'), "Header mismatch: Mcp-Method header value 'tools/list' does not match body method 'tools/call'"],
      [HDR('tools/call'), 'Header mismatch: the required Mcp-Name header is missing'],
      [HDR('tools/call', 'write_file'), "Header mismatch: Mcp-Name header value 'write_file' does not match body params.name 'read_text_file'"],
      [HDR('tools/call', '=?base64?%%%?='), 'Header mismatch: Mcp-Name has a malformed base64 value'],
    ];
    for (const [h, message] of cases) {
      const r = await post(url, call, h);
      assert.equal(r.status, 400, message);
      assert.deepEqual(r.json, { jsonrpc: '2.0', id: 9, error: { code: -32020, message } });
    }
  });
});

test('a repeated header is a mismatch', () => {
  const body = req(10, 'tools/list');
  const e = H.modernHeaderError(['MCP-Protocol-Version', '2026-07-28', 'Mcp-Method', 'tools/list', 'mcp-method', 'tools/list'], body);
  assert.deepEqual(e, { jsonrpc: '2.0', id: 10, error: { code: -32020, message: 'Header mismatch: Mcp-Method appears 2 times' } });
  assert.equal(H.modernHeaderError(['mcp-protocol-version', '2026-07-28', 'MCP-METHOD', 'tools/list'], body), null, 'names are case-insensitive');
});

test('HTTP: a 2026-07-28 notification → 202; a batch with a 2026-07-28 request → 400 -32600', async () => {
  await withServer(async url => {
    let r = await post(url, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1, _meta: META } }, HDR('notifications/cancelled'));
    assert.equal(r.status, 202);
    assert.equal(r.text, '');
    r = await post(url, [req(11, 'tools/list')], HDR('tools/list'));
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, -32600);
  });
});

test('HTTP: a legacy client keeps working next to 2026-07-28 ones', async () => {
  await withServer(async url => {
    let r = await post(url, { jsonrpc: '2.0', id: 12, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } }, { 'MCP-Protocol-Version': '2026-07-28' });
    assert.equal(r.status, 200);
    assert.equal(r.json.result.protocolVersion, '2025-11-25');
    r = await post(url, { jsonrpc: '2.0', id: 13, method: 'tools/list' }, { 'MCP-Protocol-Version': '2025-11-25' });
    assert.equal(r.status, 200);
    assert.equal(r.json.result.tools.length, 20);
    assert.equal(r.json.result.resultType, undefined);
  });
});

// --- over stdio -------------------------------------------------------------------

test('stdio: 2026-07-28 requests need no headers', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let out = '';
  output.on('data', c => (out += c));
  const { closed } = serveStdio({ input, output });
  input.write(JSON.stringify(req(1, 'server/discover')) + '\n');
  input.write(JSON.stringify(req(2, 'tools/list')) + '\n');
  input.write(JSON.stringify(req(3, 'ping')) + '\n');
  input.end();
  await closed;
  const byId = Object.fromEntries(out.trimEnd().split('\n').map(l => JSON.parse(l)).map(m => [m.id, m]));
  assert.deepEqual(byId[1].result.supportedVersions, ['2026-07-28']);
  assert.equal(byId[2].result.tools.length, 20);
  assert.equal(byId[3].error.code, -32601);
});
