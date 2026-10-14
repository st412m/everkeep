# Troubleshooting

Symptoms and what they mean: a client that shows no tools or old tools, HTTP status codes, seeing the requests, refused paths and writes, a server that does not start, and the image build. Start here when a connector misbehaves.

## The client shows no Everkeep tools

Go through these in order:

1. **Is the server running?** In Docker: `docker ps` lists `everkeep`; `docker logs everkeep` shows its start line, `everkeep 1.0.0 on 0.0.0.0:3100, vault /vault, …`.
2. **Is the token current?** `everkeep token` (in Docker: `docker exec everkeep everkeep token`) prints the path and the header in force. After `everkeep token --new` the server must be restarted, and every client updated.
3. **Does the address answer?** Run the `curl` check below against the same URL the client uses. For claude.ai, run it from another network (a phone hotspot), because claude.ai comes from the internet.
4. **Do requests arrive?** Switch on the [request log](#seeing-the-requests) and connect again.

## The tool list looks wrong

After an update that adds tools or changes parameters, a client can keep showing the old list: a tool is missing, or a parameter is not offered. The server is fine; the client is working from a schema it fetched earlier.

1. Refresh the connector's tool list in the client; if the client has no refresh, remove the connector and add it again.
2. Start a new chat.

The quick test for a stale schema is `write_file`: if it has no `rev` parameter, the client is holding an outdated schema. Do not go by the number of tools.

## HTTP status codes

| Status | Meaning |
|---|---|
| 404 | the path is not `/private_<token>/mcp` with the right token, nor `/mcp` with an `Authorization` header; the body is empty |
| 401 | `/mcp` with an `Authorization` header whose token is wrong |
| 403 | the server listens on `127.0.0.1` and the `Host` or `Origin` header is neither local nor in `allowed_hosts`; see [remote access](remote-access.md#without-docker) |
| 405 | a method other than `POST` (for example `GET`); the response carries `Allow: POST, OPTIONS` |
| 406 | the `Accept` header is missing, empty, or lists none of `application/json`, `text/event-stream`, `application/*`, `*/*` |
| 400 | the body is not valid JSON, or the `MCP-Protocol-Version` header names a version the server does not support (the body lists the supported ones) |
| 202 | a notification, which has no reply |

A successful call returns 200 with `Content-Type: application/json`, not an event stream.

A minimal check from a machine that can reach the port:

```bash
curl -s -X POST "http://127.0.0.1:3100/mcp" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Seeing the requests

Set `"log_requests": true` in the [config file](configuration.md#request-log) and restart the server. In Docker, mount the file as in `compose.example.yaml`; in the Home Assistant app it is the option `log_requests`. Every request then produces one line in the log:

```text
[req] 2026-10-13T10:56:25.478Z 160.79.106.34 POST /private_***/mcp -> 200 172B pv=- ua="Claude-User"
```

- **Requests arrive and get 200:** the path works end to end; look at the client.
- **Requests arrive and get 404 `(not found)`:** the token in the URL is wrong, or the URL does not end in `/mcp`.
- **Requests get 403 `(Host not local)`:** a tunnel or proxy on the same computer passes its public name to a server on `127.0.0.1`; add that name to `allowed_hosts`, see [remote access](remote-access.md#without-docker).
- **Nothing arrives during a connection attempt:** the requests never reach the server. Look at the tunnel, the reverse proxy or the port forwarding.

claude.ai connects from Anthropic's published egress range, `160.79.104.0/21`. Switch the log off when done.

## A path is refused

The refusal starts with `PATH_OUTSIDE_VAULT` when the path is not inside the vault. Every tool is affected, reading as well as writing, and nothing is read or written when it fires. The usual causes:

- The path is simply somewhere else, or climbs out of the vault with `..`.
- It is a sibling directory whose name starts with the vault's own — `/srv/notes_old` is not inside `/srv/notes`.
- Something on the way is a symlink leading out of the vault. This is checked against the resolved path, so a symlink that leaves the vault and points back into it is refused too, at the destination of the write.
- The client uses paths of another setup. In Docker the vault is `/vault`; `list_allowed_directories` shows the root.

## Writes are refused

- `Refused — … is read-only by policy`: the zone is read-only. Change it with `everkeep policy set`.
- `Refused — policy "overwrite: rev"`: the file exists and the zone requires its `rev`. The message states the current `rev`; repeat the call with it.
- `rev mismatch`: the file changed since it was read. Re-read and redo the edit.
- `Refused — read-only: document formats are not edited by this server`: documents are read-only.
- The listing tools print `⚠ Policy: BROKEN MARKER`: a `.vault-policy` file is unreadable and locks its whole subtree. Fix it first. See [policies.md](policies.md#if-a-marker-breaks).
- `EACCES: permission denied`: not a policy. The operating system does not let the server write there: in Docker the vault must be writable by user id 1000, see [who owns the folder](installation.md#who-owns-the-folder).

## The server does not start

Every message starts with `everkeep:`; the exit code is 1 (2 for a wrong command line).

- `no vault: pass --vault DIR, set env EVERKEEP_VAULT or "vault" in the config file` — name the vault.
- `state_dir … is inside the vault …` — move the state directory out of the vault.
- `state_dir … is not writable by this process` — the message names the user ids; in Docker, `/data` must belong to the user the container runs as.
- `token from env EVERKEEP_TOKEN: the token is too short …` — a token you set yourself breaks the rules; unset it and let the server generate one.
- `cannot listen on 127.0.0.1:3100 (EADDRINUSE)` — another program, or another Everkeep, uses the port.
- `Windows is not supported natively …` or `macOS is not supported natively …` — run it in Docker.
- The process dies with `Illegal instruction` when it reads a PDF — the CPU has no AVX and the optional `@napi-rs/canvas` is installed; reinstall without it, see [installation](installation.md#a-permanent-command-and-cpus-without-avx).

## Documents

- `… documents not indexed yet — extraction continues, repeat the call` in a `grep_files` footer: large documents are still being extracted in the background. Repeat the search later.
- `no usable text layer (scanned PDF?)`: the PDF is a scan; read its pages as images with `read_pdf_page`.
- `unsupported format: …`: the file is not a document format Everkeep reads.

More in [documents](documents.md).

## The image build fails

The image build runs `scripts/toolchain-check.sh build`. It stops with `TOOLCHAIN GUARD:` when Alpine ships a Node.js older than 22.17 or another major version of poppler or sqlite3, with `CANVAS FAIL:` when `@napi-rs/canvas` got installed, and with `SMOKE FAIL:` when the PDF, document or SQLite pipeline does not work. Each prints what was expected. See [internals](internals.md#toolchain-pinning).
