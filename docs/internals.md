# Internals

How Everkeep is put together: the process, the modules, tests and release tools, how a tool is added, and the traps worth knowing before changing the code. Read this before sending a patch.

## One process, two transports

```text
claude.ai / Claude apps                Claude Desktop / Claude Code
    ↓ HTTPS (tunnel or reverse proxy)      ↓ stdio
http.js   token check, Host/Origin     stdio.js   JSON-RPC lines on stdin/stdout
    ↓                                      ↓
server.js   JSON-RPC dispatch, the TOOLS array, callTool()
    ↓ every path through safepath.js
the vault
    ↑
policy-write.js   the only writer of .vault-policy
    ↑ everkeep policy (cli.js), the Vault policies page (policy-page.js, Home Assistant only)
```

`everkeep serve` starts the HTTP listener, the policy page when `policy_page.mode` is `ha-ingress`, and the trash auto-purge timer, all in one Node.js process. `everkeep` with no command does the same on stdio, without a token and without a page. `grep_files` forks a copy of `server.js` for each search.

Over HTTP the server speaks JSON-RPC on `POST /mcp` and answers with `Content-Type: application/json`, never an event stream. `GET` gets 405, an `Accept` header that is empty or lists none of `application/json`, `text/event-stream`, `application/*`, `*/*` gets 406 (parameters such as q-values and letter case are ignored). The server sends no notifications, and `tools/list` is static (`listChanged: false`).

Supported protocol versions are `2025-06-18`, `2025-03-26` and `2024-11-05`. `initialize` answers with the client's version if it is one of these, otherwise with `2025-06-18`. Every other request may carry an `MCP-Protocol-Version` header: without it the request is served, with a supported version it is served, and with any other value, an empty one, or the header sent twice it gets 400 with JSON-RPC error `-32600`. A request body element that is not a JSON object gets `-32600` as well.

## Modules

| File | Responsibility |
|---|---|
| `src/cli.js` | the commands: `serve`, stdio, `token`, `check-config`, `policy`; refuses Windows and macOS |
| `src/config.js` | flags, environment and config file; the state directory; writes nothing |
| `src/token.js` | where the token comes from, generation, the 0600 file, `--new` |
| `src/http.js` | the token check, Host/Origin on a local address, Streamable HTTP, the request log |
| `src/stdio.js` | the stdio transport |
| `src/server.js` | JSON-RPC dispatch, the `TOOLS` array, `callTool()`, `rev`, the grep worker |
| `src/safepath.js` | the vault boundary: `resolveSafe()` and the verified-path type every other module demands; `sameName()` and `samePath()` for letter case |
| `src/policy.js` | reading and merging `.vault-policy` markers, trash stamps, the policy line printed by the listing tools |
| `src/policy-write.js` | the only code that writes or removes markers |
| `src/policy-page.js` | the Vault policies page for the Home Assistant app |
| `src/retention.js` | the trash auto-purge sweep |
| `src/sqlite.js` | `sqlite_schema` and `sqlite_query`: open strategy, statement checks, memory-limit confirmation |
| `src/documents.js` | documents through doclines: detection, the cache, the extraction queue |
| `src/version.js` | the version, from `package.json` |
| `scripts/toolchain-check.sh` | `build`: version guard, no canvas, smoke test of PDF, documents and SQLite; `runtime`: version banner |
| `Dockerfile`, `compose.example.yaml` | the standalone image and a Compose setup |

One dependency: `doclines`, at an exact version. Everything else uses Node's built-in modules and the `pdfinfo`, `pdftoppm` and `sqlite3` binaries, called with `execFile` and an argument array, never through a shell.

The version has one source: `version` in `package.json`, read by `src/version.js` for `serverInfo`, the start line and `--version`.

### The vault boundary

The check that a path is inside the vault lives in one module, `safepath.js`, and it is the only place that can produce a path the rest of the server accepts. `policy.js`, `retention.js`, `sqlite.js` and `documents.js` accept only such a path and refuse anything else, before they touch the disk, with the code `UNVERIFIED_PATH`. That code is internal: it means one part of the server called another incorrectly. A client cannot produce it, because every tool resolves its path arguments first; in the log, it points to a bug. A path from outside the vault is a different, user-visible refusal, `PATH_OUTSIDE_VAULT`.

Moving *down* from a checked directory — the step every tree walk takes, one name at a time from a directory listing — needs no new check, because those walks do not follow symlinks. Moving *up* does: the check verifies the real path of the path itself, not of its ancestors, so the parent of a checked path is re-checked in full, and a destination reached through a symlink that leaves the vault and leads back in is refused. Every destination of a write, a directory creation or a rename is a path the check produced for that exact destination, including the name a file is given inside a trash directory.

## Adding a tool

1. Add an entry to the `TOOLS` array in `server.js`: `name`, `meta(title, h)` with the title and the four annotation hints, a short `description`, and `inputSchema`. Everything in `TOOLS` is sent to the client with `tools/list` in every session, so keep descriptions short, and say in one clause when to use a neighbouring tool instead.
2. Add a `case` to `callTool()`. Pass every path argument through `resolveSafe()` first, and hand the result to `fs` as `.path` at the call itself — a bare string will be refused by the modules behind it. For anything that writes, call `guardWrite()` and, for an existing target, `guardOverwrite()`; if the destination is built rather than resolved, resolve it before writing.
3. Return an array of MCP content blocks (`{ type: 'text', text }`, `image` or `audio`). Throw to report an error; the dispatcher turns it into `isError: true`.
4. Document it in the README's Tools list and in [tools.md](tools.md), add a test and a changelog entry.

## Tests and tools

| | |
|---|---|
| `test/*.test.js` | tests on `node:test`: `node --test "test/*.test.js"` (the quoted glob; the directory form does not work on Node 22). On Windows the tests that need Linux (symlinks, permissions, the CLI) are skipped with the reason |
| `EVERKEEP_TEST_CI_MOUNT` | a directory on a file system that ignores letter case; with it set, `test/casefold.test.js` runs its cases there |
| `tools/check-doc-examples.mjs` | checks the examples in the documentation against the source; with a second argument, also the Home Assistant app repository |
| `tools/scan-secrets.mjs` | scans the repository for private addresses, MACs, tokens, personal paths and e-mail addresses |
| `tools/check-release.mjs` | one version in `package.json`, `CHANGELOG.md`, the `Dockerfile` pin, `server.json` and `compose.example.yaml`; `server.json` limits |
| `.github/workflows/ci.yml` | on every push: `node --check`, the tests on Node 22 and 24, the three tools, the contents of `npm pack` |
| `.github/workflows/image.yml` | on a `v*` tag: builds the image for amd64 and arm64 from npm and pushes it to `ghcr.io/st412m/everkeep` |

## Traps

### Toolchain pinning

Alpine packages cannot be pinned to an exact `-rN` release: old releases are removed from the branch, and a pin breaks installation for everyone. So packages float within the Alpine branch, and `toolchain-check.sh build` fails the build when Node.js is older than `MIN_NODE_MAJOR`.`MIN_NODE_MINOR`, when the major version of poppler or sqlite3 differs from `EXPECT_POPPLER_MAJOR` or `EXPECT_SQLITE_MAJOR`, when `@napi-rs/canvas` is installed, or when the smoke test fails. The smoke test renders a generated PDF with the same flags the server uses, extracts it and an RTF string with doclines, runs `sqlite3` with the same command line as `sqlite.js`, checks the `hard_heap_limit` echo, and verifies that `-safe` blocks `ATTACH`. After a base-image change, run `read_pdf_text`, `read_pdf_page` and `sqlite_query` by hand, then update the values. The script runs through `sh`: a tarball packed on Windows loses the exec bit.

### No canvas

pdfjs, inside doclines, has an optional native dependency `@napi-rs/canvas` that crashes CPUs without AVX. Everkeep does not need it. Install with `--omit=optional`; `npm install -g` ignores that flag, which is why the images install into `/opt/everkeep` and link the command.

### The forked grep worker

`grep_files` runs in a forked copy of `server.js` (`--grep-worker <vault>`), which is killed after 10 seconds. Node cannot interrupt a running regex, so the child process is the only reliable stop. Keep `execArgv: []` in the `fork()` call; the child must not inherit the parent's Node flags. Documents are searched by a second worker in the extracted text read from the cache.

### Markers are written in one place

Only `policy-write.js` writes `.vault-policy`, and only `cli.js` and `policy-page.js` load it. `server.js` has no reference to it, a test checks that, and its tools refuse any path with a segment named `.vault-policy`. Keep it that way.

### Letter case

Reserved names (`.vault-policy`, `.vault-trash`, a zone's trash name) are compared with `sameName()`, case-insensitively, on every file system. Two paths are compared with `samePath()`: equal strings are the same path, strings that differ even ignoring case are not, and strings equal only ignoring case are compared by device and inode. Never compare paths with `===` where a trash or a marker is involved.

### English only

Comments, log messages and build messages are in English. Keep new ones in English.
