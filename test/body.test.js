'use strict';
// Request body reader: limit, drain budget, 413 delivery.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { MiB, bodyLimit, readBody, sendTooLarge } = require('../src/body.js');

const LIMIT = 1024;
const BUDGET = LIMIT + 4 * MiB;
let server, port;

test.before(async () => {
  server = http.createServer(async (req, res) => {
    const r = await readBody(req, { limit: LIMIT });
    if (r.aborted) return;
    if (!r.ok) {
      sendTooLarge(req, res, 413, { 'Content-Type': 'text/plain' }, 'too large', r.destroy);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(String(r.body.length));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
test.after(() => new Promise(r => server.close(r)));

function open(headers, onResponse) {
  return http.request({ host: '127.0.0.1', port, path: '/', method: 'POST', agent: false, headers }, onResponse);
}

// Complete request: resolves with status, headers and body text.
function request(headers, writes) {
  return new Promise((resolve, reject) => {
    const req = open(headers, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    for (const w of writes) req.write(w);
    req.end();
  });
}

// Request left open: records response status, error code and socket close time.
function watch(headers, start) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const s = { status: null, code: null, responseMs: null, closeMs: null, closedAt: null };
    const req = open(headers, res => {
      s.status = res.statusCode;
      s.responseMs = Date.now() - t0;
      res.on('error', () => {});
      res.resume();
    });
    req.on('error', e => { s.code = e.code; });
    req.on('socket', sock => sock.on('close', () => {
      s.closedAt = Date.now();
      s.closeMs = s.closedAt - t0;
      setImmediate(() => resolve(s));
    }));
    start(req, s);
  });
}

test('bodyLimit: 2 * max text + 1 MiB', () => {
  assert.equal(bodyLimit(20 * MiB), 41 * MiB);
});

test('Content-Length 2048 with the full body: 413, connection close', async () => {
  const r = await request({ 'Content-Length': '2048' }, [Buffer.alloc(2048)]);
  assert.equal(r.status, 413);
  assert.equal(r.headers.connection, 'close');
  assert.equal(r.body, 'too large');
});

test('chunked 2048 bytes in 4 writes: 413', async () => {
  const r = await request({}, [Buffer.alloc(512), Buffer.alloc(512), Buffer.alloc(512), Buffer.alloc(512)]);
  assert.equal(r.status, 413);
});

test('exactly the limit: 200', async () => {
  const r = await request({ 'Content-Length': '1024' }, [Buffer.alloc(1024)]);
  assert.equal(r.status, 200);
  assert.equal(r.body, '1024');
});

test('chunked 1023 bytes: 200', async () => {
  const r = await request({}, [Buffer.alloc(1023)]);
  assert.equal(r.status, 200);
  assert.equal(r.body, '1023');
});

test('declared length beyond the budget: socket closed within 2 s', async () => {
  const s = await watch({ 'Content-Length': String(BUDGET + 1) }, req => req.write(Buffer.alloc(2048)));
  assert.ok(s.closeMs <= 2000, `closed after ${s.closeMs} ms`);
  if (s.status !== null) assert.equal(s.status, 413);
  else assert.equal(s.code, 'ECONNRESET');
});

test('chunked body kept open: 413 after the drain timer, then close', { timeout: 15000 }, async () => {
  const s = await watch({}, req => req.write(Buffer.alloc(2048)));
  assert.equal(s.status, 413, `error: ${s.code}`);
  assert.ok(s.responseMs >= 4500 && s.responseMs <= 8000, `413 after ${s.responseMs} ms`);
  assert.ok(s.closeMs >= 4500 && s.closeMs <= 8000, `closed after ${s.closeMs} ms`);
});

test('chunked body past the budget: 413 or reset, closed within 2 s of passing it', { timeout: 15000 }, async () => {
  let passedAt = null;
  const s = await watch({}, (req, s) => {
    const chunk = Buffer.alloc(64 * 1024);
    let written = 0;
    const pump = () => {
      while (s.closedAt === null && !req.destroyed) {
        const more = req.write(chunk);
        written += chunk.length;
        if (passedAt === null && written > BUDGET) passedAt = Date.now();
        if (!more) {
          req.once('drain', pump);
          return;
        }
      }
    };
    pump();
  });
  assert.notEqual(passedAt, null, 'the budget was not passed before the socket closed');
  const ms = s.closedAt - passedAt;
  assert.ok(ms <= 2000, `closed ${ms} ms after passing the budget`);
  if (s.status !== null) assert.equal(s.status, 413);
  else assert.equal(s.code, 'ECONNRESET');
});

test('a normal request still gets 200', async () => {
  const r = await request({ 'Content-Length': '100' }, [Buffer.alloc(100)]);
  assert.equal(r.status, 200);
  assert.equal(r.body, '100');
});

test('50 oversized requests in sequence: each reads 413', async () => {
  for (let i = 1; i <= 50; i++) {
    let r;
    try {
      r = await request({ 'Content-Length': '2048' }, [Buffer.alloc(2048)]);
    } catch (e) {
      assert.fail(`iteration ${i}: ${e.code}`);
    }
    assert.equal(r.status, 413, `iteration ${i}`);
  }
});
