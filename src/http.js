'use strict';
/**
 * Everkeep over HTTP: the auth front and the Streamable HTTP transport (JSON
 * responses, no SSE) in one listener.
 *
 * Auth, in front of everything:
 * - secret path  /private_<token>/mcp  (works as a claude.ai custom connector), or
 * - /mcp with    Authorization: Bearer <token>.
 * A wrong path is a bare 404 without WWW-Authenticate, /.well-known/* is 404 (so
 * clients treat the server as authless and never start OAuth), and 401 is
 * returned only when an Authorization header was sent and is wrong. Neither the
 * token nor the request path is logged; log_requests prints the path with the
 * token masked.
 *
 * On a localhost bind (127.0.0.1, localhost, ::1) a Host or Origin header that
 * is not localhost, nor a name in allowed_hosts, is refused with 403 (DNS
 * rebinding). On any other address there are no Host/Origin checks and the
 * token alone protects the server.
 */

const crypto = require('crypto');
const http = require('http');
const S = require('./server');

const DEFAULT_HOST = '127.0.0.1';
const LOCAL_BINDS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
// Hostnames accepted in Host and Origin on a localhost bind, port-agnostic.
const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

function isLocalBind(host) {
  return LOCAL_BINDS.has(String(host).toLowerCase());
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

const MIN_TOKEN_LENGTH = 32;
// The token is also a path segment: only characters that need no URL encoding.
const TOKEN_CHARS = /^[A-Za-z0-9._~-]+$/;

class TokenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TokenError';
  }
}

// Never echoes the token.
function validateToken(token) {
  if (typeof token !== 'string' || token.length === 0) throw new TokenError('the token is empty');
  if (token.length < MIN_TOKEN_LENGTH) throw new TokenError(`the token is too short: ${token.length} chars, at least ${MIN_TOKEN_LENGTH} required`);
  if (!TOKEN_CHARS.test(token)) throw new TokenError('the token may contain only A-Z a-z 0-9 . _ ~ - (it is also a URL path segment)');
  return token;
}

// Constant time for any lengths: SHA-256 digests are compared (equal-length
// buffers).
function sameSecret(given, token) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

const PRIVATE_PREFIX = '/private_';
const MCP_SUFFIX = '/mcp';

// 'ok' | 'not_found' | 'unauthorized'
function authorize(req, token) {
  let pathname;
  try {
    pathname = new URL(req.url || '/', 'http://localhost').pathname;
  } catch {
    return 'not_found';
  }
  if (pathname.startsWith('/.well-known/')) return 'not_found';
  if (pathname.startsWith(PRIVATE_PREFIX) && pathname.endsWith(MCP_SUFFIX)) {
    const candidate = pathname.slice(PRIVATE_PREFIX.length, -MCP_SUFFIX.length);
    return sameSecret(candidate, token) ? 'ok' : 'not_found';
  }
  if (pathname === MCP_SUFFIX) {
    const header = req.headers.authorization;
    if (header === undefined) return 'not_found';
    const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
    return m && sameSecret(m[1], token) ? 'ok' : 'unauthorized';
  }
  return 'not_found';
}

// ---------------------------------------------------------------------------
// Host / Origin on a localhost bind
// ---------------------------------------------------------------------------
// null = allowed, otherwise the message for the 403. A missing Origin passes:
// non-browser clients do not send one. `allowed` (allowed_hosts, normalized by
// allowedHostnames) is accepted like localhost: the public name a tunnel or a
// proxy on this machine passes on.

// allowed_hosts as the URL parser writes host names: lower case, IPv6 in its
// short form.
function allowedHostnames(list = []) {
  return list.map(h => new URL(`http://${h}`).hostname);
}

function hostRefusal(header, allowed = []) {
  if (!header) return 'Missing Host header';
  let hostname;
  try { hostname = new URL(`http://${header}`).hostname; }
  catch { return `Invalid Host header: ${header}`; }
  return LOCAL_HOSTNAMES.includes(hostname) || allowed.includes(hostname) ? null : `Invalid Host: ${hostname}`;
}

function originRefusal(header, allowed = []) {
  if (header === undefined || header === null || header === '') return null;
  let hostname;
  try { hostname = new URL(header).hostname; }
  catch { return `Invalid Origin header: ${header}`; }
  if (hostname === '') return `Invalid Origin header: ${header}`;
  return LOCAL_HOSTNAMES.includes(hostname) || allowed.includes(hostname) ? null : `Invalid Origin: ${hostname}`;
}

// ---------------------------------------------------------------------------
// Request log (log_requests)
// ---------------------------------------------------------------------------

// A token in a path (this one or any other) is masked before it is logged.
function maskPath(url) {
  return url.replace(/\/private_[^/?]+/g, '/private_***').slice(0, 120);
}

function clientIp(req) {
  return req.headers['cf-connecting-ip']
    || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress
    || '-';
}

function requestLine(req, status, bytes, note) {
  const ua = req.headers['user-agent'] || '-';
  const pv = req.headers['mcp-protocol-version'];
  return `[req] ${new Date().toISOString()} ${clientIp(req)} ${req.method} ${maskPath(req.url)} -> ${status} ${bytes}B pv=${pv === undefined ? '-' : pv.slice(0, 40)} ua="${ua}"${note ? ' ' + note : ''}`;
}

// Counts the body bytes written to res.
function countBytes(res) {
  let n = 0;
  const count = chunk => { if (chunk && typeof chunk !== 'function') n += Buffer.byteLength(chunk); };
  const write = res.write, end = res.end;
  res.write = function (chunk, ...rest) { count(chunk); return write.call(this, chunk, ...rest); };
  res.end = function (chunk, ...rest) { count(chunk); return end.call(this, chunk, ...rest); };
  return () => n;
}

// ---------------------------------------------------------------------------
// Streamable HTTP
// ---------------------------------------------------------------------------

// Every value of one request header, by case-insensitive name.
function headerValues(rawHeaders, name) {
  const values = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (String(rawHeaders[i]).toLowerCase() === name) values.push(String(rawHeaders[i + 1]));
  }
  return values;
}

// MCP-Protocol-Version header check of a legacy request (2025-11-25 and
// earlier). Returns null when the request may proceed, or the JSON-RPC error
// body for a 400. No header passes; initialize (alone or inside a batch) is
// never checked, its version is not agreed yet.
function protocolHeaderError(rawHeaders, body) {
  const items = Array.isArray(body) ? body : [body];
  if (items.some(r => r && typeof r === 'object' && r.method === 'initialize')) return null;
  const values = headerValues(rawHeaders, 'mcp-protocol-version');
  if (!values.length) return null;
  if (values.length === 1 && S.LEGACY_PROTOCOL_VERSIONS.includes(values[0])) return null;
  return { jsonrpc: '2.0', id: null, error: { code: -32600,
    message: `Unsupported MCP-Protocol-Version: ${values.join(', ').slice(0, 40)}. Supported: ${S.LEGACY_PROTOCOL_VERSIONS.join(', ')}` } };
}

// A single request is served as 2026-07-28 when its _meta names a version, when
// it is server/discover, or when its MCP-Protocol-Version header is anything but
// one legacy version. A legacy initialize stays legacy whatever the header says.
function isModernHttpRequest(rawHeaders, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (S.isModernRequest(body)) return true;
  if (body.method === 'initialize') return false;
  const values = headerValues(rawHeaders, 'mcp-protocol-version');
  return values.length > 0 && !(values.length === 1 && S.LEGACY_PROTOCOL_VERSIONS.includes(values[0]));
}

// Mcp-Name may carry its value as =?base64?…?= (UTF-8). Returns the decoded
// value, or null when the sentinel form is malformed.
function decodeHeaderValue(v) {
  const m = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(v);
  if (m) {
    const bytes = Buffer.from(m[1], 'base64');
    return bytes.toString('base64') === m[1] ? bytes.toString('utf8') : null;
  }
  return v.startsWith('=?base64?') ? null : v;
}

function clipValue(v) {
  const s = String(v);
  return s.length > 60 ? s.slice(0, 60) + '…' : s;
}

// One header against its body value: null, or the problem.
function headerProblem(rawHeaders, name, expected, label, decode = false) {
  const values = headerValues(rawHeaders, name.toLowerCase());
  if (!values.length) return `the required ${name} header is missing`;
  if (values.length > 1) return `${name} appears ${values.length} times`;
  const got = decode ? decodeHeaderValue(values[0]) : values[0];
  if (got === null) return `${name} has a malformed base64 value`;
  if (got !== expected) return `${name} header value '${clipValue(got)}' does not match body ${label} '${clipValue(expected)}'`;
  return null;
}

// 2026-07-28 request headers against the body: MCP-Protocol-Version equal to
// the _meta version, Mcp-Method equal to method, and for tools/call Mcp-Name
// equal to params.name. Each must appear exactly once. Returns null, or the
// -32020 (HeaderMismatch) error body for a 400. Called only when the body names
// a version.
function modernHeaderError(rawHeaders, body) {
  const problem =
    headerProblem(rawHeaders, 'MCP-Protocol-Version', S.metaVersion(body), 'protocol version')
    || headerProblem(rawHeaders, 'Mcp-Method', body.method, 'method')
    || (body.method === 'tools/call' ? headerProblem(rawHeaders, 'Mcp-Name', body.params && body.params.name, 'params.name', true) : null);
  if (!problem) return null;
  return { jsonrpc: '2.0', id: body.id === undefined ? null : body.id, error: { code: -32020, message: 'Header mismatch: ' + problem } };
}

// Accept is split on commas, parameters (;q=...) dropped, case ignored.
// An empty or missing header is not accepted.
const ACCEPTED_MEDIA = new Set(['application/json', 'text/event-stream', 'application/*', '*/*']);

function acceptsMcp(header) {
  return String(header || '').split(',')
    .map(part => part.split(';')[0].trim().toLowerCase())
    .some(type => ACCEPTED_MEDIA.has(type));
}

// /mcp, past the auth front.
function transport(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, mcp-session-id, mcp-protocol-version, mcp-method, mcp-name');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // The server sends no notifications, so the GET SSE channel is declined with
  // 405 (allowed by the Streamable HTTP transport).
  if (req.method !== 'POST') { res.writeHead(405, { 'Allow': 'POST, OPTIONS' }); res.end(); return; }

  if (!acceptsMcp(req.headers['accept'])) {
    res.writeHead(406);
    res.end(JSON.stringify({ error: 'Not Acceptable: Client must accept application/json or text/event-stream' }));
    return;
  }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    try {
      await answer(req, res, chunks);
    } catch (e) {
      // An unexpected exception answers 500; the process keeps serving.
      process.stderr.write(`request failed: ${e && e.stack || e}\n`);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } }));
    }
  });
}

async function answer(req, res, chunks) {
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { res.writeHead(400); res.end('Bad JSON'); return; }

  if (isModernHttpRequest(req.rawHeaders, body)) return answerModern(req, res, body);
  if (Array.isArray(body) && body.some(r => S.isModernRequest(r))) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: protocol 2026-07-28 takes one request per POST, not a batch' } }));
    return;
  }

  const versionError = protocolHeaderError(req.rawHeaders, body);
  if (versionError) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(versionError));
    return;
  }

  const requests = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const r of requests) {
    const resp = await S.handleMcpRequest(r);
    if (resp !== null) responses.push(resp);
  }

  const result = Array.isArray(body) ? responses : (responses[0] || null);
  if (result === null) { res.writeHead(202); res.end(); return; }

  // Plain JSON, not SSE: the transport allows either, and JSON is not
  // affected by SSE buffering in tunnels.
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
}

// One 2026-07-28 request. Status by outcome: 200 result, 202 notification,
// 404 unknown method (-32601), 400 any other error.
async function answerModern(req, res, body) {
  let resp = null;
  const version = S.metaVersion(body);
  if (typeof version === 'string' && version !== '') resp = modernHeaderError(req.rawHeaders, body);
  if (!resp) resp = await S.handleModernRequest(body);
  if (resp === null) { res.writeHead(202); res.end(); return; }
  const status = !resp.error ? 200 : resp.error.code === -32601 ? 404 : 400;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(resp));
}

// ---------------------------------------------------------------------------
// Listener
// ---------------------------------------------------------------------------

function bare(res, status) {
  res.writeHead(status, { 'content-length': '0', 'cache-control': 'no-store' });
  res.end();
}

function forbidden(res, message) {
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

/**
 * The request listener: auth front → (localhost bind only) Host/Origin checks
 * → /mcp. `log` receives lines without tokens. `legacyToken` skips the token
 * rules (a pre-1.0 token kept inside Home Assistant, see token.js).
 */
function createHttpHandler({ token, host = DEFAULT_HOST, allowedHosts = [], logRequests = false, legacyToken = false, log = m => process.stderr.write(m + '\n') }) {
  if (!legacyToken) validateToken(token);
  const localGuards = isLocalBind(host);
  const allowed = allowedHostnames(allowedHosts);

  const listener = (req, res) => {
    let note = '';
    if (logRequests) {
      const bytes = countBytes(res);
      res.on('finish', () => log(requestLine(req, res.statusCode, bytes(), note)));
    }

    const verdict = authorize(req, token);
    if (verdict === 'not_found') { note = '(not found)'; return bare(res, 404); }
    if (verdict === 'unauthorized') {
      note = '(unauthorized)';
      log(`everkeep: http ${req.method} 401 (wrong bearer token)`);
      return bare(res, 401);
    }
    if (localGuards) {
      const h = hostRefusal(req.headers.host, allowed);
      if (h) { note = '(Host not local)'; log(`everkeep: http ${req.method} 403 (Host not local)`); return forbidden(res, h); }
      const o = originRefusal(req.headers.origin, allowed);
      if (o) { note = '(Origin not local)'; log(`everkeep: http ${req.method} 403 (Origin not local)`); return forbidden(res, o); }
    }
    transport(req, res);
  };
  listener.localGuards = localGuards;
  return listener;
}

function bindNote(localGuards) {
  return localGuards ? '' : ' — non-local bind: no Host/Origin checks, the token alone protects the server';
}

function startHttp({ port, host = DEFAULT_HOST, token, allowedHosts = [], logRequests = false, legacyToken = false, log }) {
  const listener = createHttpHandler({ token, host, allowedHosts, logRequests, legacyToken, log });
  const server = http.createServer(listener);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve({ server, localGuards: listener.localGuards });
    });
  });
}

module.exports = {
  DEFAULT_HOST, MIN_TOKEN_LENGTH, TokenError,
  isLocalBind, validateToken, sameSecret, authorize, allowedHostnames, hostRefusal, originRefusal,
  maskPath, protocolHeaderError, modernHeaderError, isModernHttpRequest, decodeHeaderValue, acceptsMcp,
  createHttpHandler, startHttp, bindNote,
};
