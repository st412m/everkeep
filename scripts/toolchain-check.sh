#!/bin/sh
# Toolchain check of an Everkeep image (standalone Docker image and the Home
# Assistant app). Run it with sh: a package packed on Windows has no exec bit.
#   sh .../scripts/toolchain-check.sh build    - at image build: fails when a
#       version is out of range, @napi-rs/canvas is installed, or the PDF,
#       document or SQLite pipeline does not work
#   sh .../scripts/toolchain-check.sh runtime  - prints the version banner
set -eu

# Node at least 22.17 (doclines); poppler and sqlite by major version. Patch
# releases within the Alpine branch are fine; another major stops the build.
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=17
EXPECT_POPPLER_MAJOR=25
EXPECT_SQLITE_MAJOR=3

MANIFEST=${TOOLCHAIN_MANIFEST:-/toolchain.txt}
# The everkeep package this script belongs to; doclines is resolved from it.
PKG_DIR=$(cd "$(dirname "$0")/.." && pwd)

collect() {
  NODE_V=$(node -v 2>/dev/null | sed 's/^v//' || echo '?')
  POPPLER_V=$(pdfinfo -v 2>&1 | sed -n 's/^pdfinfo version \([0-9][0-9.]*\).*/\1/p' | head -1)
  [ -n "${POPPLER_V:-}" ] || POPPLER_V='?'
  SQLITE_V=$(sqlite3 -version 2>/dev/null | awk '{print $1}')
  [ -n "${SQLITE_V:-}" ] || SQLITE_V='?'
  EVERKEEP_V=$(cd "$PKG_DIR" && node -p "require('./package.json').version" 2>/dev/null || echo '?')
  DOCLINES_V=$(cd "$PKG_DIR" && node -p "require('doclines/package.json').version" 2>/dev/null || echo '?')
}

major() { echo "$1" | sed 's/[.-].*//'; }
minor() { echo "$1" | cut -d. -f2; }

guard() {
  rc=0
  nmaj=$(major "$NODE_V"); nmin=$(minor "$NODE_V")
  case "$nmaj$nmin" in *[!0-9]*|'') nmaj=0; nmin=0 ;; esac
  if [ "$nmaj" -lt "$MIN_NODE_MAJOR" ] || { [ "$nmaj" -eq "$MIN_NODE_MAJOR" ] && [ "$nmin" -lt "$MIN_NODE_MINOR" ]; }; then
    echo "TOOLCHAIN GUARD: nodejs $NODE_V, at least $MIN_NODE_MAJOR.$MIN_NODE_MINOR required" >&2; rc=1
  fi
  if [ "$(major "$POPPLER_V")" != "$EXPECT_POPPLER_MAJOR" ]; then
    echo "TOOLCHAIN GUARD: poppler $POPPLER_V, expected major $EXPECT_POPPLER_MAJOR" >&2; rc=1
  fi
  if [ "$(major "$SQLITE_V")" != "$EXPECT_SQLITE_MAJOR" ]; then
    echo "TOOLCHAIN GUARD: sqlite3 $SQLITE_V, expected major $EXPECT_SQLITE_MAJOR" >&2; rc=1
  fi
  if [ "$DOCLINES_V" = '?' ]; then
    echo "TOOLCHAIN GUARD: doclines not found next to $PKG_DIR" >&2; rc=1
  fi
  if [ "$rc" != 0 ]; then
    echo "" >&2
    echo "Build stopped: the toolchain is not one Everkeep has been tested with." >&2
    echo "Check read_pdf_page, read_text_file on a PDF and sqlite_query by hand," >&2
    echo "then update MIN_NODE_* / EXPECT_*_MAJOR in scripts/toolchain-check.sh." >&2
    exit 1
  fi
}

# @napi-rs/canvas (an optional dependency of pdfjs) crashes CPUs without AVX:
# it must not be installed. npm may leave an empty scope folder; that is fine.
no_canvas() {
  NM=$(cd "$PKG_DIR" && node -p "require('path').dirname(require('path').dirname(require.resolve('doclines/package.json')))")
  if [ -n "$(ls -A "$NM/@napi-rs" 2>/dev/null)" ]; then
    echo "CANVAS FAIL: $NM/@napi-rs is installed; install with --omit=optional" >&2; exit 1
  fi
}

# Smoke test of what the server runs: pdfinfo (page count), pdftoppm with the
# server's flags (read_pdf_page, read_media_file), doclines on the same PDF and
# on an RTF string (read_text_file, grep_files), sqlite3 as sqlite.js calls it.
# The PDF is generated here.
smoke() {
  T=$(mktemp -d)
  # shellcheck disable=SC2064
  trap "rm -rf '$T'" EXIT

  # A one-page PDF with one line of text (at least 20 characters: doclines
  # treats a page with fewer as a scan), xref offsets computed.
  node -e '
const NL = String.fromCharCode(10);
const objs = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 80] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  null,
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
];
const content = "BT /F1 12 Tf 20 40 Td (VMCP-SMOKE-OK everkeep toolchain check) Tj ET" + NL;
objs[3] = "<< /Length " + content.length + " >>" + NL + "stream" + NL + content + "endstream";
let out = "%PDF-1.4" + NL;
const off = [];
objs.forEach((o, i) => { off.push(out.length); out += (i + 1) + " 0 obj" + NL + o + NL + "endobj" + NL; });
const x = out.length;
out += "xref" + NL + "0 " + (objs.length + 1) + NL + "0000000000 65535 f " + NL;
for (const n of off) out += String(n).padStart(10, "0") + " 00000 n " + NL;
out += "trailer" + NL + "<< /Size " + (objs.length + 1) + " /Root 1 0 R >>" + NL + "startxref" + NL + x + NL + "%%EOF" + NL;
require("fs").writeFileSync(process.argv[1], out, "latin1");
' "$T/smoke.pdf"

  # pdfinfo: the server parses the "Pages:" line
  pdfinfo "$T/smoke.pdf" | grep -Eq '^Pages:[[:space:]]+1$' \
    || { echo "SMOKE FAIL: pdfinfo did not report Pages: 1" >&2; exit 1; }

  # pdftoppm: exactly the flags of pdfPageToImage() in server.js. stderr is
  # discarded: the image has no fonts, so poppler warns that it cannot find
  # Helvetica and renders with a substitute. Exit code, file and JPEG header
  # are checked below.
  pdftoppm -jpeg -r 120 -scale-to 1400 -f 1 -l 1 "$T/smoke.pdf" "$T/page" 2>/dev/null \
    || { echo "SMOKE FAIL: pdftoppm failed" >&2; exit 1; }
  # The first page*.jpg; with no match the glob stays literal and fails -s.
  J=
  for f in "$T"/page*.jpg; do J=$f; break; done
  [ -n "$J" ] && [ -s "$J" ] || { echo "SMOKE FAIL: pdftoppm produced no JPEG" >&2; exit 1; }
  head -c 2 "$J" | od -An -tx1 | tr -d ' \n' | grep -qi 'ffd8' \
    || { echo "SMOKE FAIL: pdftoppm output is not a JPEG" >&2; exit 1; }

  # doclines, through the package the server uses: the PDF text layer (pdfjs,
  # without canvas) and an RTF string, each in its worker thread.
  printf '%s\n' '{\rtf1\ansi\deff0 {\fonttbl {\f0 Helvetica;}}\f0 Everkeep RTF smoke OK\par}' > "$T/smoke.rtf"
  (cd "$PKG_DIR" && node -e '
const D = require("doclines");
(async () => {
  const pdf = await D.extract(process.argv[1]);
  if (!pdf.lines.some(l => l.includes("VMCP-SMOKE-OK"))) throw new Error("PDF text missing: " + JSON.stringify(pdf.lines));
  const rtf = await D.extract(process.argv[2]);
  if (rtf.format !== "rtf" || !rtf.lines.some(l => l.includes("Everkeep RTF smoke OK"))) throw new Error("RTF text missing: " + JSON.stringify(rtf.lines));
})().catch(e => { console.error(String(e && e.message || e)); process.exit(1); });
' "$T/smoke.pdf" "$T/smoke.rtf") \
    || { echo "SMOKE FAIL: doclines did not extract the PDF or the RTF" >&2; exit 1; }

  # sqlite3: the command line runSqlite() in sqlite.js uses, including
  # -cmd "PRAGMA hard_heap_limit=...".
  sqlite3 "$T/smoke.db" "CREATE TABLE t(x); INSERT INTO t VALUES (1),(2),(3);" \
    || { echo "SMOKE FAIL: could not create the test database" >&2; exit 1; }
  HHL_OUT=$(sqlite3 -cmd "PRAGMA hard_heap_limit=268435456;" -readonly -safe -json "$T/smoke.db" "SELECT COUNT(*) AS n FROM t")
  # The pragma echo is the only sign that this sqlite3 build accepted the
  # limit: an unknown PRAGMA name does nothing, silently. The echo comes back
  # either as JSON or as the bare number, so the value is checked, not one
  # form (same as HEAP_LIMIT_ECHO_CANDIDATES in sqlite.js).
  echo "$HHL_OUT" | grep -Eq '^(\[\{"hard_heap_limit":268435456\}\]|268435456([^0-9]|$))' \
    || { echo "SMOKE FAIL: hard_heap_limit not confirmed by the pragma echo (got: $HHL_OUT)" >&2; exit 1; }
  echo "$HHL_OUT" | grep -q '"n":3' \
    || { echo "SMOKE FAIL: sqlite3 -readonly -safe -json did not return the expected COUNT(*)" >&2; exit 1; }

  # EXPLAIN, through the argv sqlite.js uses, including -cmd ".explain off".
  # Without it the CLI ignores -json for EXPLAIN and EXPLAIN QUERY PLAN and
  # draws a fixed-column text table, which sqlite.js reports as
  # MALFORMED_OUTPUT. A dot-command refused by -safe does not change the exit
  # status, so the output is checked: one line that opens the JSON array and
  # carries a quoted column name.
  EXP_OUT=$(sqlite3 -cmd "PRAGMA hard_heap_limit=268435456;" -cmd ".explain off" -readonly -safe -json "$T/smoke.db" "EXPLAIN SELECT 1 AS x")
  echo "$EXP_OUT" | grep -q '^\[{.*"opcode"' \
    || { echo "SMOKE FAIL: EXPLAIN did not come back as JSON — .explain off had no effect (got: $(echo "$EXP_OUT" | head -3 | tr '\n' ' '))" >&2; exit 1; }

  # -safe must refuse ATTACH; otherwise a query could read any file on the
  # disk past the vault check. A successful ATTACH fails the build.
  if sqlite3 -readonly -safe "$T/smoke.db" "ATTACH '/etc/passwd' AS x;" >/dev/null 2>&1; then
    echo "SMOKE FAIL: -safe did not block ATTACH" >&2; exit 1
  fi
}

collect
case "${1:-runtime}" in
  build)
    guard
    no_canvas
    smoke
    {
      echo "built: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
      echo "everkeep: $EVERKEEP_V"
      echo "doclines: $DOCLINES_V"
      echo "nodejs: $NODE_V"
      echo "poppler(pdfinfo/pdftoppm): $POPPLER_V"
      echo "pdf-pipeline(pdfinfo+pdftoppm+doclines): ok"
      echo "rtf-pipeline(doclines): ok"
      echo "canvas: not installed"
      echo "sqlite3: $SQLITE_V"
      echo "sqlite-pipeline(readonly+safe+json, ATTACH blocked): ok"
      echo "sqlite-explain(.explain off -> json): ok"
    } > "$MANIFEST"
    echo "Toolchain OK -> $(tr '\n' ';' < "$MANIFEST" | sed 's/;$//; s/;/; /g')"
    ;;
  runtime)
    echo "everkeep $EVERKEEP_V | doclines $DOCLINES_V | node $NODE_V | poppler $POPPLER_V | sqlite3 $SQLITE_V"
    ;;
  *)
    echo "usage: sh $0 build|runtime" >&2; exit 2
    ;;
esac
