'use strict';
/**
 * Everkeep — documents
 *
 * Binary document formats (PDF, Word, spreadsheets, presentations, OpenDocument,
 * EPUB, MSG, UTF-16 text) are read as numbered lines through doclines. doclines
 * runs every extraction in a worker thread with a timeout and a heap cap, so the
 * server keeps answering while a document is extracted; this module adds the
 * cache and a queue that extracts one document at a time.
 *
 * Cache: <state_dir>/doc-cache/ (mode 0700), one file per document, named by the
 * sha256 of "dev:ino" of the document (lstat, bigint): one entry per file, however
 * many paths lead to it (case variants on a vault that ignores case, hard
 * links). A file is a JSON header line (dev, ino, size, mtimeMs, doclines
 * version, the extraction limits, and a path the document was read under)
 * followed by the gzip of the result or the refusal. It is valid while all of
 * these but the path match. Every file is written to a temporary name and
 * renamed. Several processes may share the directory: a broken or half-written
 * entry is a miss, never an error, and eviction tolerates files that vanish
 * under it. Least recently used entries are evicted over cache_max_mb; entries
 * whose path no longer leads to the same dev/ino go first. The cache lives
 * outside the vault (cli.js refuses a state_dir inside it), so no tool can read
 * or name it.
 *
 * Every function takes a path checked by resolveSafe() (safepath.js); the grep
 * worker reads entries by the real path it was handed.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const util = require('util');
const zlib = require('zlib');
const SP = require('./safepath');
const { DOCLINES_VERSION } = require('./version');

const gzip = util.promisify(zlib.gzip);
const gunzip = util.promisify(zlib.gunzip);

const MB = 1024 * 1024;
const ENTRY = '.cache';
const STALE_TMP_MS = 60 * 60 * 1000;
const HEAP_MB = 1024;

let D = null;
function doclines() {
  if (!D) D = require('doclines');
  return D;
}

// Set by init(). cacheDir null: no cache (every read extracts; grep skips
// documents as binary files).
const CFG = {
  cacheDir: null,
  cacheMaxBytes: 512 * MB,
  maxDocBytes: 50 * MB,
  maxTextBytes: 20 * MB,
  timeoutMs: 60000,
};

function init({ stateDir = null, maxDocBytes, maxTextBytes, extractTimeoutS, cacheMaxMb } = {}) {
  CFG.cacheDir = stateDir ? path.join(stateDir, 'doc-cache') : null;
  if (maxDocBytes) CFG.maxDocBytes = maxDocBytes;
  if (maxTextBytes) CFG.maxTextBytes = maxTextBytes;
  if (extractTimeoutS) CFG.timeoutMs = extractTimeoutS * 1000;
  if (cacheMaxMb) CFG.cacheMaxBytes = cacheMaxMb * MB;
}

// The limits an extraction runs under; an entry made under other limits is a
// miss (a timeout under 60 s may succeed under 120 s).
function limits() {
  return { maxDocBytes: CFG.maxDocBytes, maxTextBytes: CFG.maxTextBytes, timeoutMs: CFG.timeoutMs, heapMb: HEAP_MB };
}

function sameLimits(a, b) {
  return !!a && a.maxDocBytes === b.maxDocBytes && a.maxTextBytes === b.maxTextBytes &&
    a.timeoutMs === b.timeoutMs && a.heapMb === b.heapMb;
}

function extractOptions(name) {
  return {
    name,
    formats: 'all',
    maxDocBytes: CFG.maxDocBytes,
    maxTextBytes: CFG.maxTextBytes,
    timeoutMs: CFG.timeoutMs,
    heapMb: HEAP_MB,
    attachments: { depth: 1 },
  };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

// What identifies a file and its state: dev and ino (strings, from a bigint
// lstat), size, mtimeMs. Throws like lstat.
function idOf(st) {
  return { dev: String(st.dev), ino: String(st.ino), size: Number(st.size), mtimeMs: Number(st.mtimeNs) / 1e6 };
}

function fileId(real) {
  return idOf(fs.lstatSync(real, { bigint: true }));
}

async function fileIdAsync(real) {
  return idOf(await fsp.lstat(real, { bigint: true }));
}

function keyOf(id) {
  return crypto.createHash('sha256').update(`${id.dev}:${id.ino}`, 'utf8').digest('hex');
}

function entryFile(cacheDir, id) {
  return path.join(cacheDir, keyOf(id) + ENTRY);
}

function headerOf(id, real) {
  return { v: 2, dev: id.dev, ino: id.ino, size: id.size, mtimeMs: id.mtimeMs, doclines: DOCLINES_VERSION, limits: limits(), path: real };
}

function headerMatches(h, id, lim) {
  return !!h && h.v === 2 && h.dev === id.dev && h.ino === id.ino && h.size === id.size &&
    h.mtimeMs === id.mtimeMs && h.doclines === DOCLINES_VERSION && sameLimits(h.limits, lim);
}

// The gzip part of a valid entry, or null for a miss. Anything wrong with the
// entry is a miss.
function parseEntry(buf, id, lim) {
  const nl = buf.indexOf(10);
  if (nl < 0) return null;
  let h;
  try { h = JSON.parse(buf.subarray(0, nl).toString('utf8')); } catch { return null; }
  if (!headerMatches(h, id, lim)) return null;
  return buf.subarray(nl + 1);
}

function bodyOf(json) {
  try {
    const b = JSON.parse(json);
    if (b && (Array.isArray(b.result?.lines) || (b.refusal && typeof b.refusal.code === 'string'))) return b;
  } catch {}
  return null;
}

async function cacheRead(id) {
  if (!CFG.cacheDir) return null;
  const file = entryFile(CFG.cacheDir, id);
  let buf;
  try { buf = await fsp.readFile(file); } catch { return null; }
  const gz = parseEntry(buf, id, limits());
  if (!gz) return null;
  let body;
  try { body = bodyOf((await gunzip(gz)).toString('utf8')); } catch { return null; }
  if (!body) return null;
  // Last use, for eviction.
  const now = new Date();
  fsp.utimes(file, now, now).catch(() => {});
  return body;
}

// The same, synchronous, for the grep worker (a separate process): `lim` are
// the limits of the server that handed it the job.
function cacheReadSync(cacheDir, real, lim) {
  let id;
  try { id = fileId(real); } catch { return null; }
  let buf;
  try { buf = fs.readFileSync(entryFile(cacheDir, id)); } catch { return null; }
  const gz = parseEntry(buf, id, lim);
  if (!gz) return null;
  try { return bodyOf(zlib.gunzipSync(gz).toString('utf8')); } catch { return null; }
}

let evicting = false;

async function cacheWrite(id, real, body) {
  if (!CFG.cacheDir) return;
  try {
    await fsp.mkdir(CFG.cacheDir, { recursive: true, mode: 0o700 });
    const file = entryFile(CFG.cacheDir, id);
    const data = Buffer.concat([
      Buffer.from(JSON.stringify(headerOf(id, real)) + '\n', 'utf8'),
      await gzip(Buffer.from(JSON.stringify(body), 'utf8')),
    ]);
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    await fsp.writeFile(tmp, data, { mode: 0o600 });
    try { await fsp.rename(tmp, file); }
    catch (e) { await fsp.unlink(tmp).catch(() => {}); throw e; }
  } catch {
    // A cache that cannot be written only costs a repeated extraction.
    return;
  }
  if (!evicting) {
    evicting = true;
    evict().catch(() => {}).finally(() => { evicting = false; });
  }
}

async function readHeader(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const b = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(b, 0, b.length, 0);
    const nl = b.subarray(0, bytesRead).indexOf(10);
    return nl < 0 ? null : JSON.parse(b.subarray(0, nl).toString('utf8'));
  } catch { return null; }
  finally { if (fh) await fh.close().catch(() => {}); }
}

// Whether the path in an entry still leads to the file the entry is about.
async function stillThere(h) {
  if (!h || typeof h.path !== 'string') return false;
  try {
    const id = await fileIdAsync(h.path);
    return id.dev === h.dev && id.ino === h.ino;
  } catch { return false; }
}

// Over the cap: entries whose path no longer leads to the same dev/ino go
// first, then the least recently used. Stale temporary files of interrupted
// writes are removed. Any file may vanish meanwhile (another process
// evicting): ENOENT is ignored.
async function evict(cacheDir = CFG.cacheDir, cap = CFG.cacheMaxBytes) {
  let names;
  try { names = await fsp.readdir(cacheDir); } catch { return; }
  const entries = [];
  let total = 0;
  const now = Date.now();
  for (const n of names) {
    const file = path.join(cacheDir, n);
    let st;
    try { st = await fsp.stat(file); } catch { continue; }
    if (n.includes('.tmp-')) {
      if (now - st.mtimeMs > STALE_TMP_MS) await fsp.unlink(file).catch(() => {});
      continue;
    }
    if (!n.endsWith(ENTRY)) continue;
    entries.push({ file, size: st.size, used: st.mtimeMs });
    total += st.size;
  }
  if (total <= cap) return;
  const gone = [];
  for (const e of entries) if (!(await stillThere(await readHeader(e.file)))) gone.push(e);
  const order = [...gone, ...entries.filter(e => !gone.includes(e)).sort((a, b) => a.used - b.used)];
  for (const e of order) {
    if (total <= cap) break;
    await fsp.unlink(e.file).catch(() => {});
    total -= e.size;
  }
}

// ---------------------------------------------------------------------------
// Queue: one extraction at a time; a read goes to the front.
// ---------------------------------------------------------------------------

const queue = [];
const jobs = new Map();   // dev:ino -> job (queued or running)
let running = null;

function schedule(key, priority, run) {
  let job = jobs.get(key);
  if (job) {
    if (priority && job !== running) {
      const i = queue.indexOf(job);
      if (i > 0) { queue.splice(i, 1); queue.unshift(job); }
    }
    return job.promise;
  }
  job = { key, run };
  job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
  jobs.set(key, job);
  if (priority) queue.unshift(job); else queue.push(job);
  pump();
  return job.promise;
}

function pump() {
  if (running || !queue.length) return;
  const job = queue.shift();
  running = job;
  Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => {
    jobs.delete(job.key);
    running = null;
    pump();
  });
}

// Extracts real (or answers from the cache) and stores the outcome.
async function extractAndCache(real, name) {
  const id = await fileIdAsync(real);
  const hit = await cacheRead(id);
  if (hit) return hit;
  let body;
  try {
    const r = await doclines().extract(real, extractOptions(name));
    body = {
      result: {
        format: r.format, label: r.label, lines: r.lines, markers: r.markers, sections: r.sections,
        pageStarts: r.pageStarts, pagesWithoutText: r.pagesWithoutText, warnings: r.warnings,
      },
    };
  } catch (e) {
    if (!(e instanceof doclines().DoclinesError) || e.code === 'not_a_file') throw e;
    // Refusals are cached too, timeout and out_of_memory included: valid until
    // the file or the limits change.
    body = { refusal: { code: e.code, message: e.message, label: e.label, format: e.format, reason: e.reason } };
  }
  // The file may have changed while it was read: cache only what still matches.
  let after;
  try { after = await fileIdAsync(real); } catch { return body; }
  if (after.size === id.size && after.mtimeMs === id.mtimeMs && after.ino === id.ino && after.dev === id.dev) await cacheWrite(id, real, body);
  return body;
}

function realOf(p) {
  return fs.realpathSync(SP.pathOf(p, 'documents'));
}

function extractByReal(real, priority) {
  let id;
  try { id = fileId(real); } catch (e) { return Promise.reject(e); }
  return schedule(`${id.dev}:${id.ino}`, priority, () => extractAndCache(real, path.basename(real)));
}

/**
 * The extracted document or its refusal: { result } | { refusal }. From the
 * cache when valid, else extracted now (ahead of background work).
 */
async function getDocument(p, { priority = true } = {}) {
  const real = realOf(p);
  const hit = await cacheRead(await fileIdAsync(real));
  if (hit) return hit;
  return extractByReal(real, priority);
}

// For grep: the cached body by real path, or null (not cached or stale).
async function cachedByReal(real) {
  let id;
  try { id = await fileIdAsync(real); } catch { return null; }
  return cacheRead(id);
}

// ---------------------------------------------------------------------------
// What a file is
// ---------------------------------------------------------------------------

// doclines formats that may be text on disk: plain text, HTML, RTF, EML, FB2.
const TEXT_CAPABLE = new Set(['text', 'html', 'rtf', 'eml', 'fb2']);

function utf16Bom(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(2);
    const n = fs.readSync(fd, b, 0, 2, 0);
    return n === 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff));
  } catch { return false; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

/**
 * How a file is read: { kind, label, format, refusal }.
 *   'text'       — plain text: read as it is on disk (2.9.0);
 *   'textOnDisk' — HTML, RTF, EML, FB2: raw unless extract is asked for;
 *   'document'   — extracted through doclines;
 *   'refused'    — not readable as text (images, archives, …): refusal.
 * A missing path or a directory is 'text', so the caller fails as before.
 */
async function classify(p) {
  const file = SP.pathOf(p, 'classify');
  let st;
  try { st = fs.statSync(file); } catch { return { kind: 'text' }; }
  if (!st.isFile()) return { kind: 'text' };
  // A cached binary document needs no detection. Formats that can be text on
  // disk (HTML, RTF, EML, FB2, plain text) are cached after extract: true too,
  // so for them detection decides.
  const real = fs.realpathSync(file);
  let hit = null;
  try { hit = await cacheRead(fileId(real)); } catch {}
  const f = hit && (hit.result ? hit.result.format : hit.refusal.format);
  if (f && !TEXT_CAPABLE.has(f)) {
    return { kind: 'document', label: hit.result ? hit.result.label : hit.refusal.label, format: f };
  }
  const d = await doclines().detect(file, { maxDocBytes: CFG.maxDocBytes });
  if (d.refusal && d.refusal.code === 'not_a_file') return { kind: 'text' };
  if (d.format === 'text') return utf16Bom(file) ? { kind: 'document', label: d.label, format: 'text' } : { kind: 'text', label: d.label, format: 'text' };
  if (!d.format) return { kind: 'refused', label: d.label, format: null, refusal: Object.assign({ label: d.label }, d.refusal) };
  if (d.textOnDisk) return { kind: 'textOnDisk', label: d.label, format: d.format };
  return { kind: 'document', label: d.label, format: d.format, refusal: d.refusal };
}

// get_file_info: the label of the format, or null for a directory or a missing
// file.
async function formatLabel(p) {
  const file = SP.pathOf(p, 'formatLabel');
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile()) return null;
  const d = await doclines().detect(file, { maxDocBytes: CFG.maxDocBytes });
  if (d.format === 'text' && utf16Bom(file)) return `${d.label} (UTF-16)`;
  return d.label || (d.refusal ? d.refusal.message : null);
}

function cacheEnabled() {
  return CFG.cacheDir !== null;
}

module.exports = {
  init, classify, getDocument, formatLabel, cacheEnabled,
  cachedByReal, extractByReal, cacheReadSync, evict, entryFile, fileId, limits,
  CFG,
};
