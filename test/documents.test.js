'use strict';
// Documents (§7, SPEC-doclines §10.2–10.5): reads, ranges, grep, the cache,
// refusals. Fixtures are copies of doclines test fixtures (test/fixtures/NOTICE).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { tmpDir } = require('./helpers.js');

const S = require('../src/server.js');
const DOCS = require('../src/documents.js');

const FIX = path.join(__dirname, 'fixtures', 'documents');
const V = tmpDir();
const STATE = tmpDir();
const J = (...a) => path.join(V, ...a);
for (const f of fs.readdirSync(FIX)) fs.copyFileSync(path.join(FIX, f), J(f));
fs.mkdirSync(J('zone'));
fs.writeFileSync(J('zone', '.vault-policy'), '{"overwrite":"rev","trash":".vault-trash"}\n');
fs.mkdirSync(J('zone', '.vault-trash'));
fs.copyFileSync(path.join(FIX, 'text.docx'), J('zone', '.vault-trash', 'old__trash-20260101T000000Z.docx'));
S.init(V, { docs: { stateDir: STATE } });
const CACHE = path.join(STATE, 'doc-cache');

async function call(name, args) {
  const r = await S.handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return { text: r.result.content.map(c => c.text).join('\n'), isError: r.result.isError === true };
}

async function doclinesLines(file) {
  const D = require('doclines');
  return (await D.extract(file, { maxTextBytes: 20971520 })).lines;
}

// "n| text" lines of a read, markers left out.
const numbered = text => text.split('\n').slice(1).filter(l => /^\d+\| /.test(l));

test('DOCX, XLSX, PDF: numbered lines, markers unnumbered, numbering = doclines', async () => {
  for (const [f, label] of [['text.docx', 'Word document (.docx)'], ['text.xlsx', 'Excel workbook (.xlsx)'], ['text.pdf', 'PDF document (.pdf)']]) {
    const r = await call('read_text_file', { path: J(f) });
    assert.ok(!r.isError, r.text);
    const lines = await doclinesLines(J(f));
    assert.equal(r.text.split('\n')[0], `${J(f)} · ${label} · lines 1-${lines.length} of ${lines.length}`);
    assert.deepEqual(numbered(r.text), lines.map((l, i) => `${i + 1}| ${l}`));
    assert.ok(!r.text.includes(' · rev '), 'no rev for documents');
  }
  const x = await call('read_text_file', { path: J('text.xlsx') });
  assert.deepEqual(x.text.split('\n').filter(l => l.startsWith('---')), ['--- sheet 1: Данные ---', '--- sheet 2: Скрытый (hidden) ---', '--- sheet 3: Second ---']);
  assert.ok(x.text.includes('\n--- sheet 1: Данные ---\n1| [1] Parameter | Min | Max | Date | Note\n'), x.text);
  const p = await call('read_text_file', { path: J('text.pdf') });
  assert.equal(p.text.split('\n')[1], '--- page 1 ---');
});

test('ranges: offset/limit, head, tail work on the extracted lines', async () => {
  let r = await call('read_text_file', { path: J('text.xlsx'), offset: 2, limit: 3 });
  assert.equal(r.text, `${J('text.xlsx')} · Excel workbook (.xlsx) · lines 2-4 of 10\n2| [2] Temperature | -40 | 105 | 2026-11-27 | Мука, 2 м\n3| [3] Voltage | 3 | 3.6 | 2026-02-17 11:00:00 | TRUE\n4| [5] НМЦК | 3605044 | 7210088 | 11:00:00 | #N/A`);
  r = await call('read_text_file', { path: J('text.xlsx'), offset: 9 });
  assert.equal(r.text, `${J('text.xlsx')} · Excel workbook (.xlsx) · lines 9-10 of 10\n--- sheet 2: Скрытый (hidden) ---\n9| [1] Hidden sheet text\n--- sheet 3: Second ---\n10| [1] Second sheet | -0.5`);
  r = await call('read_text_file', { path: J('text.docx'), head: 2 });
  assert.deepEqual(numbered(r.text), ['1| Fixture: cheap-eyes formats', '2| Bid security: 1 000 000 PKR. Deadline: 2026-02-17 11:00.']);
  r = await call('read_text_file', { path: J('text.docx'), tail: 1 });
  assert.equal(r.text, `${J('text.docx')} · Word document (.docx) · lines 11-11 of 11\n11| End of fixture.`);
  r = await call('read_text_file', { path: J('text.docx'), offset: 12 });
  assert.equal(r.text, 'Error: offset 12 is past the end of the file (11 lines)');
  r = await call('read_file', { path: J('text.docx'), offset: 8, limit: 1 });
  assert.equal(r.text, `${J('text.docx')} · Word document (.docx) · lines 8-8 of 11\n8| Temperature | −40 | 105`);
});

test('read_pdf_text: page range, the same line numbers as read_text_file', async () => {
  const a = await call('read_pdf_text', { path: J('text.pdf') });
  const b = await call('read_text_file', { path: J('text.pdf') });
  assert.equal(a.text.split('\n')[0], `${J('text.pdf')} · PDF document (.pdf) · pages 1-1 of 1 · lines 1-11 of 11`);
  assert.deepEqual(a.text.split('\n').slice(1), b.text.split('\n').slice(1));
  assert.equal((await call('read_pdf_text', { path: J('text.pdf'), first_page: 1, last_page: 1 })).text, a.text);
  const bad = await call('read_pdf_text', { path: J('text.pdf'), first_page: 2 });
  assert.equal(bad.text, 'Error: Page range 2-1 out of range (1-1)');
  assert.equal((await call('read_pdf_text', { path: J('text.docx') })).text, `Error: Not a PDF file: ${J('text.docx')}`);
});

test('a scan is never a silent empty result: the reply names read_pdf_page', async () => {
  let r = await call('read_text_file', { path: J('refused-scan.pdf') });
  assert.ok(r.isError);
  assert.match(r.text, /^Error: no usable text layer \(scanned PDF\?\): refused-scan\.pdf — the PDF has no text layer; read its pages as images with read_pdf_page( \(pages 1-\d+\))?\.$/);
  r = await call('read_pdf_text', { path: J('refused-scan.pdf') });
  assert.ok(!r.isError);
  assert.match(r.text, /^.*refused-scan\.pdf · PDF document \(\.pdf\) · no text layer\n\n\(no extractable text — the PDF is scanned; read its pages as images with read_pdf_page(, pages 1-\d+)?\)$/);
});

test('a refused format gives its refusal; an image points to read_media_file', async () => {
  const r = await call('read_text_file', { path: J('refused-image.png') });
  assert.equal(r.text, 'Error: unsupported format: image (PNG), no OCR (refused-image.png) — view it with read_media_file.');
});

test('HTML and EML read raw with rev; extract:true gives their text', async () => {
  const raw = await call('read_text_file', { path: J('utf8.html'), offset: 1, limit: 2 });
  assert.match(raw.text, /^.*utf8\.html · rev [0-9a-f]{8} · lines 1-2 of \d+\n<!DOCTYPE html>\n<html>/);
  assert.equal((await call('read_text_file', { path: J('utf8.html') })).text, fs.readFileSync(J('utf8.html'), 'utf8'));
  const ex = await call('read_text_file', { path: J('utf8.html'), extract: true });
  assert.equal(ex.text.split('\n')[0], `${J('utf8.html')} · HTML page (.html) · lines 1-12 of 12`);
  assert.ok(ex.text.includes('\n9| Temperature | −40 | 105\n'), ex.text);
  const eml = await call('read_text_file', { path: J('mail-mixed.eml'), extract: true });
  assert.ok(eml.text.includes('\n1| From: Иван Тестов <ivan@example.com>\n'), eml.text);
  assert.ok(eml.text.includes('\n--- attachment: text.docx ---\n'), eml.text);
  assert.ok((await call('read_text_file', { path: J('mail-mixed.eml') })).text.startsWith('From: =?utf-8?B?'));
});

test('read_multiple_files: documents extracted, refusals per file, the trash skipped', async () => {
  const r = await call('read_multiple_files', { paths: [J('text.docx'), J('refused-image.png'), J('zone', '.vault-trash', 'old__trash-20260101T000000Z.docx')] });
  assert.ok(r.text.startsWith(`=== ${J('text.docx')} ===\n${J('text.docx')} · Word document (.docx) · lines 1-11 of 11\n1| Fixture`), r.text);
  assert.ok(r.text.includes(`=== ${J('refused-image.png')} ===\nERROR: unsupported format: image (PNG), no OCR (refused-image.png) — view it with read_media_file.`), r.text);
  assert.ok(r.text.includes('ERROR: this file is in the trash — bulk reads skip it'), r.text);
});

test('grep_files: documents searched in their text with sections; documents:false skips them; the trash is skipped', async () => {
  let r = await call('grep_files', { path: V, pattern: 'Temperature' });
  assert.ok(!r.isError, r.text);
  assert.ok(r.text.includes(`${J('text.docx')} · Word document (.docx) · 11 lines\n  L8: Temperature | −40 | 105`), r.text);
  assert.ok(r.text.includes(`${J('text.pdf')} · PDF document (.pdf) · 11 lines\n  L8 (p.1): Temperature −40 105`), r.text);
  assert.ok(r.text.includes(`${J('text.xlsx')} · Excel workbook (.xlsx) · 10 lines\n  L2 (sheet Данные): [2] Temperature | -40 | 105 | 2026-11-27 | Мука, 2 м`), r.text);
  assert.ok(!r.text.includes('old__trash'), 'the trash is not searched');
  assert.match(r.text, /— 4 match\(es\) in 4 file\(s\) · scanned \d+\/\d+ files, \d+ KB, \d+ ms · 2 binary skipped$/);
  r = await call('grep_files', { path: V, pattern: 'Temperature', documents: false });
  assert.match(r.text, /— 1 match\(es\) in 1 file\(s\)/);
  assert.ok(!r.text.includes('text.docx'));
  r = await call('grep_files', { path: V, pattern: 'Hidden sheet', context: 1 });
  assert.ok(r.text.includes('  L9 (sheet Скрытый): [1] Hidden sheet text'), r.text);
  assert.ok(r.text.includes('  L8 (sheet Данные)- [1000] Row one thousand | 36:00:00'), r.text);
});

test('grep_files: documents not extracted in time are queued and named in the footer', async () => {
  const V2 = path.join(V, 'later');
  fs.mkdirSync(V2);
  fs.copyFileSync(path.join(FIX, 'text.docx'), path.join(V2, 'a.docx'));
  fs.copyFileSync(path.join(FIX, 'text.xlsx'), path.join(V2, 'b.xlsx'));
  S.setGrepDocBudget(0);
  try {
    const r = await call('grep_files', { path: V2, pattern: 'Temperature' });
    assert.equal(r.text.split('\n')[0], 'No matches.');
    assert.match(r.text, / · 2 documents not indexed yet — extraction continues, repeat the call$/);
  } finally {
    S.setGrepDocBudget(6000);
  }
  // The background queue extracts them; the next call finds them.
  let r;
  for (let i = 0; i < 100; i++) {
    r = await call('grep_files', { path: V2, pattern: 'Temperature' });
    if (!r.text.includes('not indexed')) break;
    await new Promise(res => setTimeout(res, 100));
  }
  assert.match(r.text, /— 2 match\(es\) in 2 file\(s\)/);
});

test('get_file_info names the format', async () => {
  const info = JSON.parse((await call('get_file_info', { path: J('text.xlsx') })).text);
  assert.equal(info.format, 'Excel workbook (.xlsx)');
  assert.equal(JSON.parse((await call('get_file_info', { path: J('utf8.html') })).text).format, 'HTML page (.html)');
  assert.equal(JSON.parse((await call('get_file_info', { path: J('refused-image.png') })).text).format, 'image (PNG), no OCR');
  assert.equal(JSON.parse((await call('get_file_info', { path: J('zone') })).text).format, undefined);
});

test('edit_file and write_file over a document are refused; a new file of that name is not', async () => {
  const before = fs.readFileSync(J('text.docx'));
  let r = await call('write_file', { path: J('text.docx'), content: 'x' });
  assert.equal(r.text, `Error: Refused — read-only: document formats are not edited by this server (${J('text.docx')} is Word document (.docx)). Nothing was written.`);
  r = await call('edit_file', { path: J('text.pdf'), edits: [{ oldText: 'PDF', newText: 'x' }] });
  assert.equal(r.text, `Error: Refused — read-only: document formats are not edited by this server (${J('text.pdf')} is PDF document (.pdf)). Nothing was written.`);
  assert.deepEqual(fs.readFileSync(J('text.docx')), before);
  r = await call('write_file', { path: J('new.docx'), content: 'plain text, not a document\n' });
  assert.ok(!r.isError, r.text);
  // Text on disk stays editable.
  r = await call('edit_file', { path: J('utf8.html'), edits: [{ oldText: 'End of fixture.', newText: 'End of fixture!' }] });
  assert.ok(!r.isError, r.text);
  // Moving and trashing a document are unchanged.
  fs.copyFileSync(path.join(FIX, 'text.docx'), J('zone', 'doc.docx'));
  r = await call('move_file', { source: J('zone', 'doc.docx'), destination: J('zone', 'moved.docx') });
  assert.ok(r.isError && r.text.includes('requires its current rev'), r.text);
});

// ---- the cache ----

// The entry of a file: sha256 of "dev:ino" (lstat, bigint).
function idOf(file) {
  const st = fs.lstatSync(file, { bigint: true });
  return { dev: String(st.dev), ino: String(st.ino), size: Number(st.size), mtimeMs: Number(st.mtimeNs) / 1e6 };
}
const keyFile = real => { const id = idOf(real); return path.join(CACHE, crypto.createHash('sha256').update(`${id.dev}:${id.ino}`, 'utf8').digest('hex') + '.cache'); };
const LIMITS = { maxDocBytes: 52428800, maxTextBytes: 20971520, timeoutMs: 60000, heapMb: 1024 };

test('cache: one entry per document, keyed by dev:ino, header + gzip, mode 0700', async () => {
  await call('read_text_file', { path: J('text.docx') });
  const real = fs.realpathSync(J('text.docx'));
  const buf = fs.readFileSync(keyFile(real));
  const nl = buf.indexOf(10);
  const h = JSON.parse(buf.subarray(0, nl).toString());
  const id = idOf(real);
  assert.deepEqual(h, { v: 2, dev: id.dev, ino: id.ino, size: id.size, mtimeMs: id.mtimeMs, doclines: require('doclines/package.json').version, limits: LIMITS, path: real });
  const body = JSON.parse(zlib.gunzipSync(buf.subarray(nl + 1)).toString());
  assert.equal(body.result.label, 'Word document (.docx)');
  assert.equal(body.result.lines.length, 11);
  if (process.platform !== 'win32') assert.equal(fs.statSync(CACHE).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(CACHE).filter(n => n.includes('.tmp-')), []);
});

test('cache: miss → hit → invalidated by mtime; a broken entry is a miss', async () => {
  const f = J('cached.docx');
  fs.copyFileSync(path.join(FIX, 'text.docx'), f);
  const real = fs.realpathSync(f);
  assert.equal(fs.existsSync(keyFile(real)), false, 'miss: no entry yet');
  let r = await call('read_text_file', { path: f, offset: 1, limit: 1 });
  assert.equal(numbered(r.text)[0], '1| Fixture: cheap-eyes formats');
  assert.ok(fs.existsSync(keyFile(real)), 'written on the miss');

  // Hit: the answer comes from the entry (tampered here to tell it apart).
  const buf = fs.readFileSync(keyFile(real));
  const nl = buf.indexOf(10);
  const body = JSON.parse(zlib.gunzipSync(buf.subarray(nl + 1)).toString());
  body.result.lines[0] = 'FROM THE CACHE';
  fs.writeFileSync(keyFile(real), Buffer.concat([buf.subarray(0, nl + 1), zlib.gzipSync(JSON.stringify(body))]));
  r = await call('read_text_file', { path: f, offset: 1, limit: 1 });
  assert.equal(numbered(r.text)[0], '1| FROM THE CACHE');

  // A new mtime invalidates it.
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(f, t, t);
  r = await call('read_text_file', { path: f, offset: 1, limit: 1 });
  assert.equal(numbered(r.text)[0], '1| Fixture: cheap-eyes formats');

  // Half-written or garbage entries are misses, never errors.
  for (const junk of [Buffer.from('not a header'), Buffer.concat([buf.subarray(0, nl + 1), Buffer.from('broken gzip')]), Buffer.alloc(0)]) {
    fs.writeFileSync(keyFile(real), junk);
    r = await call('read_text_file', { path: f, offset: 1, limit: 1 });
    assert.ok(!r.isError, r.text);
    assert.equal(numbered(r.text)[0], '1| Fixture: cheap-eyes formats');
  }
});

test('cache: refusals are cached too', async () => {
  await call('read_text_file', { path: J('refused-scan.pdf') });
  const buf = fs.readFileSync(keyFile(fs.realpathSync(J('refused-scan.pdf'))));
  const body = JSON.parse(zlib.gunzipSync(buf.subarray(buf.indexOf(10) + 1)).toString());
  assert.equal(body.refusal.code, 'no_text_layer');
});

test('cache: eviction keeps under the cap, drops entries whose path no longer leads to the file first, tolerates vanished files', async () => {
  const dir = tmpDir();
  const live = idOf(J('text.docx'));
  const mk = (name, p, size, used, id = live) => {
    const file = path.join(dir, name + '.cache');
    fs.writeFileSync(file, JSON.stringify({ v: 2, dev: id.dev, ino: id.ino, path: p }) + '\n' + 'x'.repeat(size));
    const t = new Date(used);
    fs.utimesSync(file, t, t);
    return file;
  };
  const old = mk('old', J('text.docx'), 1000, Date.now() - 3000);
  const newer = mk('newer', J('text.docx'), 1000, Date.now() - 1000);
  const gone = mk('gone', path.join(V, 'no-such-file.docx'), 1000, Date.now());
  // The path exists but is another file now: gone as well.
  const replaced = mk('replaced', J('text.pdf'), 1000, Date.now());
  const staleTmp = path.join(dir, 'x.cache.tmp-1-ab');
  fs.writeFileSync(staleTmp, 'half');
  fs.utimesSync(staleTmp, new Date(Date.now() - 2 * 3600 * 1000), new Date(Date.now() - 2 * 3600 * 1000));
  const size = file => fs.statSync(file).size;
  await DOCS.evict(dir, size(old) + size(newer));
  assert.equal(fs.existsSync(gone), false, 'missing document first');
  assert.equal(fs.existsSync(replaced), false, 'another file under the path');
  assert.equal(fs.existsSync(staleTmp), false, 'stale temporary file');
  assert.equal(fs.existsSync(newer), true);
  assert.equal(fs.existsSync(old), true, 'under the cap after the missing one');
  await DOCS.evict(dir, size(newer));
  assert.equal(fs.existsSync(old), false, 'least recently used next');
  assert.equal(fs.existsSync(newer), true);
  await DOCS.evict(path.join(dir, 'missing-dir'), 1);
});

test('the cache cannot be reached through tools', async () => {
  const r = await call('read_text_file', { path: keyFile(fs.realpathSync(J('text.docx'))) });
  assert.match(r.text, /^Error: PATH_OUTSIDE_VAULT: /);
  const C = require('../src/config.js');
  assert.throws(() => C.assertStateOutsideVault(path.join(V, 'state'), V), /state_dir .* is inside the vault .*: it holds the token and the document cache, which the tools must not reach/);
  assert.throws(() => C.assertStateOutsideVault(V, V), /inside the vault/);
  assert.doesNotThrow(() => C.assertStateOutsideVault(STATE, V));
  // A vault of "/" (or a drive root) holds every state_dir.
  const fsRoot = path.parse(STATE).root;
  assert.throws(() => C.assertStateOutsideVault(STATE, fsRoot), /inside the vault/);
  assert.throws(() => C.assertStateOutsideVault(fsRoot, fsRoot), /inside the vault/);
  // A sibling sharing the name prefix and a name starting with ".." are outside.
  assert.doesNotThrow(() => C.assertStateOutsideVault(V + '_state', V));
  assert.doesNotThrow(() => C.assertStateOutsideVault(path.join(path.dirname(V), '..x'), V));
});

test('mixed PDF: the text of page 1 and "pages without text: 2" with the hint', async () => {
  const gen = require('./fixtures/make-mixed-pdf.js');
  assert.deepEqual(fs.readFileSync(path.join(FIX, 'mixed-pages.pdf')), gen.build(), 'the fixture is what the generator writes');
  let r = await call('read_text_file', { path: J('mixed-pages.pdf') });
  assert.equal(r.text, [
    `${J('mixed-pages.pdf')} · PDF document (.pdf) · lines 1-1 of 1`,
    'pages without text: 2 — read them as images with read_pdf_page',
    '--- page 1 ---',
    `1| ${gen.TEXT}`,
    '--- page 2 ---',
  ].join('\n'));
  r = await call('read_pdf_text', { path: J('mixed-pages.pdf') });
  assert.equal(r.text.split('\n').slice(0, 2).join('\n'), `${J('mixed-pages.pdf')} · PDF document (.pdf) · pages 1-2 of 2 · lines 1-1 of 1\npages without text: 2 — read them as images with read_pdf_page`);
  r = await call('read_pdf_text', { path: J('mixed-pages.pdf'), first_page: 1, last_page: 1 });
  assert.equal(r.text, `${J('mixed-pages.pdf')} · PDF document (.pdf) · pages 1-1 of 2 · lines 1-1 of 1\n--- page 1 ---\n1| ${gen.TEXT}`);
  assert.ok(!r.text.includes('pages without text'), r.text);
  r = await call('read_pdf_text', { path: J('mixed-pages.pdf'), first_page: 2, last_page: 2 });
  assert.equal(r.text.split('\n').slice(0, 2).join('\n'), `${J('mixed-pages.pdf')} · PDF document (.pdf) · pages 2-2 of 2 · no text lines\npages without text: 2 — read them as images with read_pdf_page`);
});

test('cache: a timeout is cached until the limits change, then the file is extracted again', async () => {
  const f = J('slow.xlsx');
  fs.copyFileSync(path.join(FIX, 'text.xlsx'), f);
  DOCS.init({ stateDir: STATE, extractTimeoutS: 0.001 });
  try {
    let r = await call('read_text_file', { path: f });
    assert.ok(r.isError);
    assert.match(r.text, /^Error: extraction timed out after 0\.001 s: slow\.xlsx$/);
    const buf = fs.readFileSync(keyFile(f));
    const h = JSON.parse(buf.subarray(0, buf.indexOf(10)).toString());
    assert.equal(h.limits.timeoutMs, 1);
    assert.equal(JSON.parse(zlib.gunzipSync(buf.subarray(buf.indexOf(10) + 1)).toString()).refusal.code, 'timeout');
    // Cached: the same answer again, from the same entry.
    r = await call('read_text_file', { path: f });
    assert.match(r.text, /timed out/);
    assert.deepEqual(fs.readFileSync(keyFile(f)), buf);
  } finally {
    DOCS.init({ stateDir: STATE, extractTimeoutS: 60 });
  }
  const r = await call('read_text_file', { path: f, offset: 2, limit: 1 });
  assert.ok(!r.isError, r.text);
  assert.equal(r.text.split('\n')[1], '2| [2] Temperature | -40 | 105 | 2026-11-27 | Мука, 2 м');
  const buf = fs.readFileSync(keyFile(f));
  assert.equal(JSON.parse(buf.subarray(0, buf.indexOf(10)).toString()).limits.timeoutMs, 60000);
});

test('cache: a hard link to a document shares its entry', async () => {
  await call('read_text_file', { path: J('text.docx'), head: 1 });
  try { fs.linkSync(J('text.docx'), J('hard.docx')); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const before = fs.readdirSync(CACHE).filter(n => n.endsWith('.cache')).length;
  const r = await call('read_text_file', { path: J('hard.docx'), offset: 8, limit: 1 });
  assert.equal(r.text, `${J('hard.docx')} · Word document (.docx) · lines 8-8 of 11\n8| Temperature | −40 | 105`);
  assert.equal(fs.readdirSync(CACHE).filter(n => n.endsWith('.cache')).length, before, 'no second entry');
  assert.equal(keyFile(J('hard.docx')), keyFile(J('text.docx')));
});

test('UTF-16 text is extracted; UTF-8 text reads as on disk', async () => {
  fs.writeFileSync(J('u16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('первая\nвторая\n', 'utf16le')]));
  let r = await call('read_text_file', { path: J('u16.txt') });
  assert.equal(r.text, `${J('u16.txt')} · plain text · lines 1-2 of 2\n1| первая\n2| вторая`.replace('plain text', r.text.split(' · ')[1]));
  assert.deepEqual(numbered(r.text), ['1| первая', '2| вторая']);
  fs.writeFileSync(J('u8.txt'), 'one\ntwo\n');
  r = await call('read_text_file', { path: J('u8.txt') });
  assert.equal(r.text, 'one\ntwo\n');
});
