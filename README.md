# Everkeep

**Stop re-explaining yourself to your AI.**

Everkeep keeps your notes, decisions and projects in one folder on your own server. Your AI assistant reads it when a chat starts and writes down what you worked out — so tomorrow's conversation picks up where today's ended. You decide what it may change; it can't delete or overwrite anything you haven't allowed.

Works with Claude and any MCP client · runs on Linux, Docker or Home Assistant

### Your documents, too

Drop contracts, invoices, manuals, price lists and exported reports into the folder as they are — PDF, Word, Excel, PowerPoint, e-mails. Your AI reads them as text, searches all of them at once and tells you where it found the answer: *"which contract has a 30-day payment term?"* comes back with the file and the page. No uploading files into every chat, no copy-pasting; a new version of a file is read the next time it is needed. Scanned pages it looks at as images.

Files go into the folder by ordinary copying, like into any other folder: see [putting your files in](https://github.com/st412m/everkeep/blob/main/docs/your-files.md).

## Quick start

This gets Everkeep running on your own computer with Docker and connects Claude to it. You need about ten minutes and no programming.

**1. Install Docker.** On Windows or macOS, install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and start it; wait until it says Docker is running. On Linux, install [Docker Engine](https://docs.docker.com/engine/install/).

**2. Start Everkeep.** Open a terminal (on Windows: PowerShell; on macOS: Terminal) and paste the two lines for your system. The first creates the folder `everkeep-notes` in your home folder; that folder is where your notes will live. The second downloads Everkeep and starts it in the background; it starts again by itself after a reboot.

Windows (PowerShell):

```powershell
mkdir $HOME\everkeep-notes
docker run -d --name everkeep --restart unless-stopped -p 127.0.0.1:3100:3100 -v "$HOME\everkeep-notes:/vault" -v everkeep-data:/data ghcr.io/st412m/everkeep:1.0.0
```

macOS or Linux:

```sh
mkdir -p ~/everkeep-notes
docker run -d --name everkeep --restart unless-stopped -p 127.0.0.1:3100:3100 -v "$HOME/everkeep-notes:/vault" -v everkeep-data:/data ghcr.io/st412m/everkeep:1.0.0
```

On Linux the folder must be writable by user id 1000. If the command `id -u` prints a different number, follow [Docker: who owns the folder](https://github.com/st412m/everkeep/blob/main/docs/installation.md#who-owns-the-folder) instead.

**3. Protect your notes.** One more line, in the same terminal:

```sh
docker exec everkeep everkeep policy set . --mode rev --trash
```

From now on Claude can create new files in the folder, but it can change an existing file only after reading it, so it never overwrites what it has not seen. Nothing is deleted: a file Claude discards goes into the folder `.vault-trash` inside `everkeep-notes`, and you can take it back from there.

**4. Get your token.** Everkeep made a secret token on its first start. Show it:

```sh
docker exec everkeep everkeep token
```

It prints two lines. The first is the secret path for claude.ai, the second the header for other clients:

```
/private_<token>/mcp
Authorization: Bearer <token>
```

Treat both like a password: whoever has them can read and change your notes.

**5. Connect Claude.**

- **Claude Code on the same computer:**

  ```sh
  claude mcp add --transport http everkeep http://127.0.0.1:3100/mcp --header "Authorization: Bearer <token>"
  ```

- **Claude Desktop on the same computer:** add the block from [Claude Desktop](https://github.com/st412m/everkeep/blob/main/docs/installation.md#claude-desktop) to its config file and restart it.
- **claude.ai in the browser, or the Claude apps:** they connect from the internet, so Everkeep needs a public HTTPS address. [Remote access](https://github.com/st412m/everkeep/blob/main/docs/remote-access.md) shows two free ways, step by step. Then, in **claude.ai → Settings → Connectors → Add custom connector**, paste `https://<your public address>/private_<token>/mcp`.

**6. Try it.**

- Ask Claude: *"Use Everkeep to create a file `about-me.md` with what you know about my current projects."* The file appears in your `everkeep-notes` folder.
- Open the folder: on Windows, type `explorer $HOME\everkeep-notes` in the same PowerShell (or go to This PC → Users → your name → `everkeep-notes`); on macOS, type `open ~/everkeep-notes` in Terminal (or Finder → your home folder); on Linux, open your home folder in the file manager.
- Copy a contract, an invoice or any PDF or Word file into it, by dragging or copy and paste, as into any folder. Everkeep sees it at once; nothing needs restarting. Folders inside it are fine and useful: `contracts/`, `projects/…`.
- Ask Claude: *"Use Everkeep: what does the contract in my notes say about payment terms? Give the page."*

To have Claude read your notes at the start of every chat, add a line like this in **Settings → Account → Instructions for Claude**, or to a project's instructions: *"At the start of a chat, read `/vault/about-me.md` with Everkeep."* Inside Docker your folder is `/vault`.

To change the rules for a folder, see [Write policies](#write-policies).

## What it is

Everkeep is an [MCP](https://modelcontextprotocol.io) server. MCP is the way AI clients such as Claude call tools on other machines. Everkeep's tools work on one directory tree, the *vault*: read, search, edit, move and discard files, read documents and PDFs, query SQLite databases read-only. Nothing outside the vault can be reached through it.

What the assistant may change is set per directory with *write policies*: a directory can be read-only, editable only by someone who has read the current version of a file, open to new files only, or free. There is no delete: discarding moves a file into a trash directory of its zone. The assistant cannot change the policies; you set them on the server.

It runs as one process, over HTTP for remote clients such as claude.ai and over stdio for local ones such as Claude Desktop.

## What it looks like

The assistant lists a directory. The first line says what is allowed there:

```text
Policy: overwrite=rev, trash=.vault-trash, auto-purge after 30 d — own marker (/vault/wiki/.vault-policy)

[FILE] .vault-policy
[DIR] .vault-trash
[FILE] decisions.md
[FILE] todo.md
```

It tries to overwrite `todo.md` without having read it, and is refused:

```text
Error: Refused — policy "overwrite: rev": changing an existing file requires its current rev, which is 5db20d56. Nothing was written. Repeat the call with rev: "5db20d56".
```

It searches, gets line numbers and the file's `rev`, and edits one line:

```text
/vault/wiki/todo.md · rev 5db20d56 · 212 lines
  148: - [ ] Check backup-rotation settings on the NAS

— 1 match(es) in 1 file(s) · scanned 37/37 files, 190 KB, 12 ms
```

## Requirements

| | |
|---|---|
| Docker | Docker Desktop (Windows, macOS) or Docker Engine (Linux); images for amd64 and arm64 (Raspberry Pi 4/5) |
| Linux without Docker | Node.js ≥ 22.17, `poppler-utils` (`pdfinfo`, `pdftoppm`), `sqlite3` |
| Home Assistant | OS or Supervised, through the [ha-filesystem-mcp](https://github.com/st412m/ha-filesystem-mcp) app |
| Disk | the Docker image is about 340 MB; the npm package with its dependencies about 48 MB |
| For claude.ai | a public HTTPS address: see [remote access](https://github.com/st412m/everkeep/blob/main/docs/remote-access.md) |

## Installation

### Docker

The image `ghcr.io/st412m/everkeep` runs `everkeep serve` on port 3100 as user id 1000, with the vault at `/vault` and its own state (token, document cache) in the volume `/data`. The [Quick start](#quick-start) shows `docker run`; [compose.example.yaml](https://github.com/st412m/everkeep/blob/main/compose.example.yaml) does the same with Docker Compose. Folder ownership, updates and building the image yourself: [installation](https://github.com/st412m/everkeep/blob/main/docs/installation.md#docker).

### Linux without Docker

Install `poppler-utils` and `sqlite3` with your package manager, then run it with npx:

```sh
npx --yes --package=everkeep everkeep serve --vault /home/me/notes
```

On first start it prints the token once; `everkeep token` shows it again. For a permanent `everkeep` command, a CPU without AVX (some Celeron, Atom and Pentium models) and a systemd service, see [installation](https://github.com/st412m/everkeep/blob/main/docs/installation.md#linux-without-docker). Windows and macOS are not supported without Docker.

### Home Assistant

Install the [ha-filesystem-mcp](https://github.com/st412m/ha-filesystem-mcp) app. It runs Everkeep with the vault under `/media` or `/share` and adds the Vault policies page to the sidebar.

## Configuration

Settings come from flags, environment variables and an optional JSON file (`EVERKEEP_CONFIG`, else `~/.config/everkeep/config.json`). The ones to know first:

| Setting | Flag / variable | Default |
|---|---|---|
| `vault` | `--vault`, `EVERKEEP_VAULT` | none, required |
| `host` | `--host` | `127.0.0.1` |
| `port` | `--port` | `3100` |
| `state_dir` | `EVERKEEP_STATE_DIR` | `~/.local/state/everkeep` |
| token | `--token-file`, `EVERKEEP_TOKEN` | generated into `<state_dir>/token` |

`everkeep check-config` prints what is in force and checks the tools Everkeep needs. Every key, the token rules and the request log: [configuration](https://github.com/st412m/everkeep/blob/main/docs/configuration.md).

## Connecting

- **claude.ai, Claude Desktop connectors, the Claude apps:** **Settings → Connectors → Add custom connector** with `https://<your-host>/private_<token>/mcp`. The address must be public HTTPS: [remote access](https://github.com/st412m/everkeep/blob/main/docs/remote-access.md).
- **Claude Code:** over HTTP with the Bearer header, or on stdio:

  ```sh
  claude mcp add --transport stdio everkeep -- npx --yes --package=everkeep everkeep --vault /home/me/notes
  ```

- **Claude Desktop without a public address:** Everkeep on stdio through Docker, see [Claude Desktop](https://github.com/st412m/everkeep/blob/main/docs/installation.md#claude-desktop).
- **Cursor and other clients:** the URL `http://127.0.0.1:3100/mcp` (or your HTTPS address) with the header `Authorization: Bearer <token>`, see [installation](https://github.com/st412m/everkeep/blob/main/docs/installation.md#other-clients).

There is no OAuth: the token is the only key. A wrong path gets an empty 404, a wrong Bearer token 401.

## Tools

20 tools. Parameters and return formats: [tools](https://github.com/st412m/everkeep/blob/main/docs/tools.md).

**Reading**
- `read_text_file` — a whole file, `head`/`tail` lines, or an `offset`/`limit` range with line count and `rev`; documents as numbered lines
- `read_file` — deprecated alias of `read_text_file`
- `read_multiple_files` — several whole files in one response
- `read_media_file` — image or audio as base64; a PDF page as JPEG (`#N` suffix on the path)
- `read_pdf_text` — text of a PDF or a page range, numbered like `read_text_file`
- `read_pdf_page` — one PDF page rendered as JPEG

**Searching**
- `grep_files` — regex search of file contents, documents included; returns path, `rev`, line count and matching lines
- `search_files` — find files and directories by name

**Writing**
- `write_file` — create or overwrite a file
- `edit_file` — literal `oldText` replacement, or line-addressed edits guarded by `rev`
- `create_directory` — create a directory and its parents
- `move_file` — move or rename a file or directory; also restores from the trash
- `trash_file` — move a file into its zone's trash; there is no delete

**Listing**
- `list_directory` — entries of one directory, after the policy line
- `list_directory_with_sizes` — entries with file sizes, sorted by name or size
- `directory_tree` — tree view, two levels deep
- `get_file_info` — size, times and format, plus line count and `rev` for text files
- `list_allowed_directories` — the vault root

**SQLite (read-only)**
- `sqlite_schema` — DDL of every object, file pragmas, optional row counts
- `sqlite_query` — one `SELECT`/`WITH`/`VALUES`/`EXPLAIN` statement, with a row limit

The search-then-edit workflow is in [search and edit](https://github.com/st412m/everkeep/blob/main/docs/search-and-edit.md), SQLite in [sqlite](https://github.com/st412m/everkeep/blob/main/docs/sqlite.md).

## Write policies

With no policies, any tool may write anywhere in the vault. A policy is a small file `.vault-policy` in a directory; it covers the directory and everything below it. Set it on the server:

```sh
everkeep policy set wiki --mode rev --trash --purge-days 30 --vault /home/me/notes
everkeep policy set raw --mode readonly --vault /home/me/notes
```

| Mode | Effect |
|---|---|
| `readonly` | no writes, edits, moves in or out, or discards |
| `rev` | new files are free; changing, moving out or discarding an existing file needs its current `rev` |
| `never` | new files only; existing files cannot be changed |
| `free` | no checks |

With Docker, run the same commands inside the container: `docker exec everkeep everkeep policy show`. In the Home Assistant app, use the Vault policies page in the sidebar. The trash, auto-purge and what a broken marker does: [write policies](https://github.com/st412m/everkeep/blob/main/docs/policies.md).

## Documents and formats

`read_text_file` and `grep_files` read PDF, Word, Excel, PowerPoint, OpenDocument, EPUB, FB2, RTF, HTML and mail files as numbered lines with page, sheet and slide markers; `grep_files` reports where a match is (`L8 (p.1)`, `L2 (sheet Data)`). A scanned PDF has no text; the answer says which pages to read as images with `read_pdf_page`. Documents are read-only. Extracted text is cached outside the vault. Formats, limits and the cache: [documents](https://github.com/st412m/everkeep/blob/main/docs/documents.md).

## Limitations

- **Linux only without Docker.** Windows and macOS run it in Docker.
- **No OAuth.** The token in the path or the Bearer header is the only key.
- **No delete.** `trash_file` moves a file into a trash directory, and only in a zone that has one.
- **SQLite is read-only** and will stay so.
- **Documents are read-only**, and scans are not recognized as text (no OCR).
- **Policies stop Everkeep's tools only.** Anything else that writes to the folder — you, a sync job, a file share — does not see them.
- **Clients cache the tool list.** After an update that changes tools, an open conversation keeps the old list.

## Troubleshooting

- **Claude shows no Everkeep tools.** Check that the container runs (`docker ps`), that the token in the URL or header is the current one (`everkeep token`), and for claude.ai that the HTTPS address answers from outside.
- **Every write fails with `EACCES`.** The vault folder is not writable by the user Everkeep runs as (user id 1000 in Docker).
- **400 / 401 / 403 / 404 / 405 / 406.** 401: wrong Bearer token. 404: wrong path or token in the path. 403: a `Host` or `Origin` that is neither local nor in `allowed_hosts`, on a server listening on `127.0.0.1`. 405: not `POST`. 406: the `Accept` header lists neither JSON nor event streams. 400: bad JSON or an unsupported `MCP-Protocol-Version`.
- **Every write is refused and listings print `⚠ Policy: BROKEN MARKER`.** A `.vault-policy` file is broken and locks its zone. Fix it with `everkeep policy` or by hand.

More: [troubleshooting](https://github.com/st412m/everkeep/blob/main/docs/troubleshooting.md).

## Security

- The token is a password. It is generated by the server, at least 32 characters, never logged; put TLS in front of any address that leaves your machine.
- Every path is confined to the vault, including through symlinks and on case-insensitive file systems.
- On `127.0.0.1` (the default without Docker) requests whose `Host` or `Origin` is not local are refused, which stops websites in your browser from reaching it.
- The token and the document cache live in the state directory, which must be outside the vault.
- `grep_files` runs in a child process killed after 10 seconds; documents are extracted in worker threads with a timeout and a memory cap; SQLite runs `sqlite3 -readonly -safe`.

More: [security](https://github.com/st412m/everkeep/blob/main/docs/security.md).

## Links

- [Documentation](https://github.com/st412m/everkeep/tree/main/docs) —
  [installation](https://github.com/st412m/everkeep/blob/main/docs/installation.md),
  [putting your files in](https://github.com/st412m/everkeep/blob/main/docs/your-files.md),
  [remote access](https://github.com/st412m/everkeep/blob/main/docs/remote-access.md),
  [configuration](https://github.com/st412m/everkeep/blob/main/docs/configuration.md),
  [write policies](https://github.com/st412m/everkeep/blob/main/docs/policies.md),
  [tools](https://github.com/st412m/everkeep/blob/main/docs/tools.md),
  [search and edit](https://github.com/st412m/everkeep/blob/main/docs/search-and-edit.md),
  [documents](https://github.com/st412m/everkeep/blob/main/docs/documents.md),
  [sqlite](https://github.com/st412m/everkeep/blob/main/docs/sqlite.md),
  [security](https://github.com/st412m/everkeep/blob/main/docs/security.md),
  [troubleshooting](https://github.com/st412m/everkeep/blob/main/docs/troubleshooting.md),
  [internals](https://github.com/st412m/everkeep/blob/main/docs/internals.md)
- [Home Assistant app](https://github.com/st412m/ha-filesystem-mcp)
- [Changelog](https://github.com/st412m/everkeep/blob/main/CHANGELOG.md)
- Issues: problems of the server here; problems of installing or running the Home Assistant app in [ha-filesystem-mcp](https://github.com/st412m/ha-filesystem-mcp/issues)

## License

[MIT](https://github.com/st412m/everkeep/blob/main/LICENSE) — by st412m.
