# Documents

How Everkeep reads PDF, Word, Excel, PowerPoint, OpenDocument, e-books and mail: which formats, what the answer looks like, scanned PDFs, searching inside documents, the limits and the cache. Read this when the assistant works with documents in the vault, or when a document is refused.

Extraction is done by the [doclines](https://www.npmjs.com/package/doclines) package. Documents are read-only: no tool changes them.

## Formats

| Format | Files | Places in the text |
|---|---|---|
| PDF document | `.pdf` | pages |
| Word document | `.docx`, `.docm`, `.dotx`, `.dotm`, `.doc` | footnotes, endnotes |
| Excel workbook | `.xlsx`, `.xlsm`, `.xltx`, `.xltm`, `.xls` | sheets, hidden ones marked |
| OpenDocument | `.odt`, `.ott`, `.ods`, `.odp`, `.otp` | sheets, slides |
| PowerPoint presentation | `.pptx`, `.pptm`, `.potx`, `.potm`, `.ppsx`, `.ppt` | slides, speaker notes |
| EPUB book, FictionBook | `.epub`, `.fb2` | chapters |
| Mail | `.eml`, `.msg` | attachments, read as well |
| RTF document, HTML page | `.rtf`, `.html`, `.htm`, `.xhtml` | |
| Text in UTF-16 | any | |

The format is detected from the content, not the extension. Images, archives and other binary files are refused with the reason; an image points to `read_media_file`:

```text
Error: unsupported format: image (PNG), no OCR (refused-image.png) — view it with read_media_file.
```

## What a document looks like

`read_text_file` and `read_multiple_files` return a document as numbered lines. Markers for pages, sheets, slides and attachments sit on lines of their own, without a number. The header names the format and has no `rev`:

```text
/vault/docs/text.xlsx · Excel workbook (.xlsx) · lines 8-10 of 10
8| [1000] Row one thousand | 36:00:00
--- sheet 2: Скрытый (hidden) ---
9| [1] Hidden sheet text
--- sheet 3: Second ---
10| [1] Second sheet | -0.5
```

Table rows come out one per line, cells joined by ` | `; a spreadsheet row starts with its row number in brackets. `offset`/`limit`, `head` and `tail` count the numbered lines. Without them, a long document returns its first 100 KB of text and says to use `offset`/`limit` for the rest.

`read_pdf_text` returns the same lines with the same numbers, for a range of pages.

### HTML, RTF, mail and FictionBook

These four are text on disk. By default they read raw, like any text file, with a `rev`, and can be edited. With `extract: true` they read as a document:

```text
/vault/docs/mail-mixed.eml · email message (.eml) · lines 1-3 of 32
1| From: Иван Тестов <ivan@example.com>
2| To: buyer@example.org
3| Cc: audit@example.net
```

A mail message is followed by its attachments, each after a marker `--- attachment: <name> ---`.

## Scanned PDFs

A scan has no text layer. doclines refuses a PDF whose pages carry on average fewer than 20 non-space characters, and the answer names the tool to use instead:

```text
Error: no usable text layer (scanned PDF?): refused-scan.pdf — the PDF has no text layer; read its pages as images with read_pdf_page (pages 1-1).
```

`read_pdf_text` answers the same case without an error:

```text
/vault/docs/refused-scan.pdf · PDF document (.pdf) · no text layer

(no extractable text — the PDF is scanned; read its pages as images with read_pdf_page, pages 1-1)
```

A PDF with text on some pages and none on others is read, and the header lists the empty pages:

```text
/vault/docs/mixed-pages.pdf · PDF document (.pdf) · lines 1-1 of 1
pages without text: 2 — read them as images with read_pdf_page
--- page 1 ---
1| Mixed pages fixture: page one carries this line of text, page two is empty.
--- page 2 ---
```

There is no OCR: the assistant reads page images itself with `read_pdf_page`.

## Searching documents

`grep_files` searches documents in their extracted text. Their blocks come after the text files, without `rev`, and each match says where it is: `p.N` for a PDF page, `sheet <name>`, `slide N`, `chapter N`, `attachment <name>`:

```text
/vault/docs/utf8.html · rev e26f6d02 · 17 lines
  12: <tr><td>Temperature</td><td>−40</td><td>105</td></tr>

/vault/docs/text.docx · Word document (.docx) · 11 lines
  L8: Temperature | −40 | 105

/vault/docs/text.pdf · PDF document (.pdf) · 11 lines
  L8 (p.1): Temperature −40 105

/vault/docs/text.xlsx · Excel workbook (.xlsx) · 10 lines
  L2 (sheet Данные): [2] Temperature | -40 | 105 | 2026-11-27 | Мука, 2 м

— 4 match(es) in 4 file(s) · scanned 6/8 files, 12 KB, 163 ms · 2 binary skipped
```

The `L` number is the line number `read_text_file` gives, so a match can be read in context with `offset`. With `context`, neighbouring lines are printed with `-` instead of `:`.

A document is extracted the first time it is read or searched; after that its text comes from the cache. `grep_files` spends at most 6 of its 10 seconds on extraction. Documents it could not reach in that time are extracted in the background, and the footer says so:

```text
— 1 match(es) in 1 file(s) · scanned 12/40 files, 96 KB, 9874 ms · 3 documents not indexed yet — extraction continues, repeat the call
```

Repeat the call after a while. `documents: false` skips documents entirely.

Refused documents (scans, images) count as `binary skipped` in the footer.

## Documents are read-only

`write_file` or `copy_file` over an existing document and `edit_file` on one are refused:

```text
Error: Refused — read-only: document formats are not edited by this server (/vault/docs/text.docx is Word document (.docx)). Nothing was written.
```

A new file with a document extension can be written: it is just text. `move_file` and `trash_file` work on documents as on any file, and `copy_file` copies one to a new path. `get_file_info` reports the detected type in `format`, for example `"Excel workbook (.xlsx)"`.

## Limits

Set in the [configuration](configuration.md#keys):

| Key | Default | |
|---|---|---|
| `max_doc_bytes` | 50 MB | larger documents are refused |
| `max_text_bytes` | 20 MB | extracted text of one document, at most |
| `extract_timeout_s` | 60 | one extraction, at most |
| `cache_max_mb` | 512 | size of the cache |

Each extraction runs in a worker thread with that timeout and a 1 GB memory cap, one document at a time, so the server keeps answering while a large file is read. A document that times out is refused until it or the limits change.

## The cache

Extracted text is kept in `doc-cache` inside the [state directory](configuration.md#the-state-directory), never inside the vault: no tool can read it. One entry per file, compressed; an entry is valid while the file's size and modification time, the doclines version and the limits are the same, so a changed file is extracted again. Refusals are cached too. Over `cache_max_mb`, entries of files that are gone are removed first, then the least recently used.

Several Everkeep processes (an HTTP server and stdio sessions) can share one state directory and its cache. In the Home Assistant app the cache is `/data/doc-cache` and is left out of Home Assistant backups.
