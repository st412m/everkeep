'use strict';
// Builds test/fixtures/documents/mixed-pages.pdf: a two-page PDF 1.4 written
// by hand (no dependencies). Page 1 holds one line of text in the standard
// Helvetica font; page 2 has an empty content stream (a page without text, as
// a scanned page is to a text extractor). The cross-reference offsets are
// computed here, so the file is valid as written.
//
//   node test/fixtures/make-mixed-pdf.js     rewrites the fixture
// documents.test.js checks that the committed file equals build().

const fs = require('fs');
const path = require('path');

const TEXT = 'Mixed pages fixture: page one carries this line of text, page two is empty.';

function build() {
  const content = `BT /F1 11 Tf 40 760 Td (${TEXT}) Tj ET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 6 0 R /Resources << >> >>',
    '<< /Length 0 >>\nstream\n\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

if (require.main === module) {
  const file = path.join(__dirname, 'documents', 'mixed-pages.pdf');
  fs.writeFileSync(file, build());
  process.stdout.write(`${file}\n`);
}

module.exports = { build, TEXT };
