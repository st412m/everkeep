'use strict';
// read_media_file: images and audio only; a PDF, with or without the old "#N"
// suffix, is refused with a pointer to read_pdf_page / read_pdf_text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers.js');

const S = require('../src/server.js');

const FIX = path.join(__dirname, 'fixtures', 'documents');
const V = tmpDir();
const J = (...a) => path.join(V, ...a);
fs.copyFileSync(path.join(FIX, 'text.pdf'), J('text.pdf'));
fs.copyFileSync(path.join(FIX, 'refused-image.png'), J('scan#2.png'));
S.init(V);

async function call(args) {
  const r = await S.handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_media_file', arguments: args } });
  return { content: r.result.content, text: r.result.content.map(c => c.text || '').join('\n'), isError: r.result.isError === true };
}

test('a PDF is refused with a pointer, with or without the old #N suffix', async () => {
  for (const p of [J('text.pdf'), J('text.pdf') + '#2', J('TEXT.PDF#')]) {
    const r = await call({ path: p });
    assert.equal(r.isError, true, p);
    assert.match(r.text, /does not read PDF .*read_pdf_page with path and page, the text is read_pdf_text/, r.text);
  }
});

test('an image whose name holds "#" is read as it is named', async () => {
  const r = await call({ path: J('scan#2.png') });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.content[0].type, 'image');
  assert.equal(r.content[0].mimeType, 'image/png');
  assert.equal(Buffer.from(r.content[0].data, 'base64').length, fs.statSync(J('scan#2.png')).size);
});

test('the description names read_pdf_page and read_pdf_text and has no "#N"', async () => {
  const r = await S.handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const t = r.result.tools.find(x => x.name === 'read_media_file');
  assert.match(t.description, /read_pdf_page/);
  assert.match(t.description, /read_pdf_text/);
  assert.doesNotMatch(t.description, /#N/);
});
