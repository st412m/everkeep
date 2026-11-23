# Changelog

## 1.2.0 — 2026-11-23

### Added
- **Windows and macOS without Docker.** Everkeep runs natively on Windows and macOS with Node.js 22.17 or later. On Windows, names Windows cannot keep are refused below the vault root with `PATH_WINDOWS_NAME` (`:`, a trailing space or period, device names such as `CON` or `COM1` with or without an extension, `\\?\` and `\\.\` paths, 8.3 short names); a junction out of the vault is refused; a vault on a UNC path works; a marker held open by another program is retried for under a second, then the change is refused with a message saying so. On macOS, APFS without case or Unicode-normalization distinctions is handled like the other case-insensitive file systems; a path that spells the vault root in another case or Unicode form is refused with `PATH_OUTSIDE_VAULT` and a hint naming the root. macOS is tested in CI on GitHub's macOS runners, not yet on a real Mac.
- **Claude Desktop extension** for Windows and macOS: `everkeep-<version>.mcpb`, attached to each GitHub release. Claude Desktop runs Everkeep with its own Node.js over stdio; no Docker, address or token. Its settings hold the Notes folder (default `everkeep` in the home folder) and Read-only folders. On the first start in a folder, the folder is created if missing, a starter `CLAUDE.md` is written when neither `CLAUDE.md` nor `AGENTS.md` is there, and a root marker (edits need the current rev, trash on) when the folder has none; once per folder, remembered in the state directory. Each read-only folder gets a read-only marker, removed again when the folder leaves the list; a marker the person set is left alone. Refusals and markers name the extension settings. On macOS the extension puts Homebrew's folders in front of PATH. Tested on Windows, not yet on macOS.
- **`everkeep init [DIR] [--agent claude|other]`** creates a vault (default `~/everkeep`) with a starter instruction file (`CLAUDE.md`, or `AGENTS.md` with `--agent other`) and a starter policy (edits need the current rev, trash on), saves it as the default vault and runs `check-config`. It never overwrites anything, and refuses the home folder, a drive root, the state directory and a folder inside another vault. A server started without a vault says to run `everkeep init` or set `EVERKEEP_VAULT`; `EVERKEEP_VAULT` is optional in `server.json`.
- **Server instructions** in `initialize` and `server/discover`: read the vault's `CLAUDE.md` (or `AGENTS.md` when there is no `CLAUDE.md`) before the first vault operation in a session; while that file is still the unchanged starter, before the first reply. With neither file, a one-line description of the server. The tool list is unchanged.
- **Vault policies page for `everkeep serve`** (policy page mode `token`, the default outside Home Assistant): `/private_<token>/policies` on the same port, behind the same token. Saving needs an `Origin` whose host is the request's `Host` or listed in `allowed_hosts`; the page is sent with `no-store`, no referrer and no framing. `everkeep token` and the start line print its URL. The Home Assistant app keeps its ingress page.

### Changed
- `grep_files` runs in a worker thread that is stopped after 10 seconds, not in a child process: Claude Desktop's built-in Node does not let a server start its own executable.
- CI runs on Node 22, 24 and 26, on Linux, Windows and macOS (macOS: on a case-sensitive APFS image as well, with Homebrew sqlite and poppler).
- Documentation: one «Without Docker» section for Linux, macOS and Windows with the Node.js, poppler and sqlite install lines; a vault on its own drive in Home Assistant (Local disk storage); deleting over a Samba share is permanent.

### Fixed
- `edit_file` with `oldText`/`newText` inserts the new text exactly as given: `$&`, `` $` ``, `$'` and `$$` in it were expanded as replacement patterns.

### Security
- Request bodies are limited: `/mcp` to twice `max_text_bytes` plus 1 MiB (41 MiB by default), the policy page to 1 MiB. A larger request gets 413 with `Connection: close`, on `/mcp` with a JSON-RPC error saying to write big files in parts; the token is checked first. Before, the body was read whole, so a client with the token could fill the server's memory.

## 1.1.0 — 2026-10-27

### Added
- **MCP protocol 2026-07-28** next to the earlier revisions, over HTTP and stdio: no `initialize`, the protocol version and client capabilities in every request's `_meta`, `server/discover`, `resultType` and `serverInfo` in every result, `ttlMs` and `cacheScope` on `tools/list` and `server/discover`. Over HTTP the `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers are checked against the body (`-32020` on a mismatch), an unsupported version gets `-32022` with the supported list, an unknown method 404. Clients on 2025-11-25 and earlier keep the `initialize` handshake.
- **`copy_file`**: copies a file inside the vault; the destination follows the rules of `write_file` (missing parents created, overwriting an existing file only where the zone allows it, read-only zones, the trash, marker names and existing documents refused). Directories are not copied.
- Protocol revision 2025-11-25 for clients that use `initialize`; it is now the answer to an unknown version.

### Removed
- `read_file`, the deprecated alias of `read_text_file`: use `read_text_file`. Still 20 tools.
- The `#N` page suffix of `read_media_file` (`manual.pdf#3`): one PDF page as an image is `read_pdf_page`. A PDF given to `read_media_file`, with or without the suffix, is refused with that pointer.

### Changed
- EML text follows postal-mime 4.1.4: body text dropped in some malformed messages is extracted; a `message/rfc822` attachment keeps the line endings of the message, so its size in the attachment list can differ. Cached document text is extracted again once, since the cache is tied to the doclines version.
- A JSON-RPC notification is never answered, whatever its method.
- `trash_file` says in its description that a directory is not discarded as a unit.

### Fixed
- `read_media_file` reads an image whose name contains `#`; the path was cut at the `#` before.

### Security
- doclines 0.1.1 with postal-mime 4.1.4: fixes GHSA-f2hq-32vh-53cc (quadratic CPU time when decoding a mail header made of many joinable RFC 2047 base64 encoded words).

## 1.0.0 — 2026-10-14

Continues ha-filesystem-mcp 2.9.0: the same server, now a standalone npm package that runs on Linux, in Docker and as the Home Assistant app.

### Added
- **Documents.** `read_text_file`, `read_multiple_files`, `read_pdf_text` and `grep_files` read PDF, Word (DOCX, DOC), Excel (XLSX, XLS), OpenDocument (ODT, ODS, ODP), PowerPoint (PPTX, PPT), EPUB, FB2, RTF, HTML and mail (EML, MSG, with attachments) as numbered lines with page, sheet, slide and attachment markers, through the `doclines` package. HTML, RTF, EML and FB2 read raw by default; `extract: true` gives their text. A scanned PDF is refused with the pages to read as images with `read_pdf_page`; a PDF with some pages without text lists those pages. Documents are read-only. Extracted text is cached in the state directory, outside the vault.
- **One folder, the vault.** Every tool works inside one directory tree. A path outside it, a path that climbs out with `..`, a sibling directory whose name starts with the vault's own, or a symlink that leads out is refused with `PATH_OUTSIDE_VAULT`, and nothing is read or written.
- **20 tools**, each with a title and MCP annotations: reading (`read_text_file`, `read_file`, `read_multiple_files`, `read_media_file`, `read_pdf_text`, `read_pdf_page`), searching (`grep_files`, `search_files`), writing (`write_file`, `edit_file`, `create_directory`, `move_file`, `trash_file`), listing (`list_directory`, `list_directory_with_sizes`, `directory_tree`, `get_file_info`, `list_allowed_directories`), SQLite (`sqlite_schema`, `sqlite_query`). Tool descriptions say when to use a tool instead of its neighbour.
- **Search and line edits.** `grep_files` returns path, `rev` and line count per file and numbered matching lines; `read_text_file` with `offset`/`limit` returns a range with the file's `rev`; `edit_file` replaces, inserts and deletes by line number in one atomic pass, guarded by `rev` (the first 8 hex characters of the SHA-256 of the content). A stale `rev` is refused and nothing is written.
- **Write policies.** A `.vault-policy` marker in a directory sets its zone: read-only, edits only with the current `rev`, new files only, or free writes. Fields are inherited per field by the directories below. A marker that cannot be read locks its whole zone against writes. The listing tools print the policy in force.
- **Trash instead of delete.** `trash_file` moves a file into its zone's trash with the arrival time stamped into the name; `move_file` brings it back. Auto-purge, off by default, erases files older than a set number of days from a zone's trash, once after start and then daily.
- **Policy editing outside the tools.** `everkeep policy show|set|clear` on the server; in the Home Assistant app, the Vault policies page. Both write the same marker, and a directory's marker holds only what the directory sets itself: a subdirectory that changes only its mode shares the trash of the directory above. MCP tools cannot create, change, move or discard a marker, or a file or directory named like one.
- **PDF pages as images** (`read_pdf_page`, `read_media_file` with `#N`) through poppler's `pdftoppm`.
- **SQLite, read-only.** `sqlite_schema` and `sqlite_query` run `sqlite3 -readonly -safe` under a 256 MiB memory limit; one `SELECT`, `WITH`, `VALUES` or `EXPLAIN` statement, checked by a tokenizer before `sqlite3` starts; a database with a live `-wal` is read from a private copy.
- **Case-insensitive file systems.** The marker and trash names are compared regardless of case, and two paths that differ only in case are compared by the file they lead to, so a vault on exFAT, NTFS, a Windows or macOS folder mounted into Docker, or ext4 with casefold keeps its policies.
- **A path segment named like the marker is refused** in any position, so no tool can create a directory called `.vault-policy`.
- **Two transports in one process.** `everkeep serve`: MCP Streamable HTTP on `/mcp`, JSON responses. `everkeep` with no command: MCP on stdio, the same tools and policies.
- **Token.** Generated by the server on its first start (32 random bytes as 64 hex characters, file mode 0600) and shown once; `everkeep token` shows it again, `everkeep token --new` replaces it. Accepted as the secret path `/private_<token>/mcp` (for claude.ai custom connectors) or as `Authorization: Bearer <token>` on `/mcp`. A wrong path gets an empty 404, a wrong Bearer token 401, `/.well-known/*` 404. On a localhost bind, a `Host` or `Origin` that is not localhost gets 403; `allowed_hosts` names the public host of a tunnel or proxy on the same machine that is accepted like localhost.
- **Configuration** from flags, environment and a JSON file (`EVERKEEP_CONFIG` or `~/.config/everkeep/config.json`); `everkeep check-config` validates it and checks `pdfinfo`, `pdftoppm`, `sqlite3` and the case sensitivity of the vault. `everkeep.example.json` lists every key with its default.
- **Docker image** `ghcr.io/st412m/everkeep` for linux/amd64 and linux/arm64: Node 22 on Alpine with poppler and sqlite, runs as uid 1000, vault at `/vault`, state at `/data`. `compose.example.yaml` shows a complete setup.
- Optional one-line request log (`log_requests`), with the token masked.
- Refuses to start natively on Windows and macOS, pointing to Docker.
