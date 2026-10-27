# Configuration

Where Everkeep takes its settings from, every key, the token, the state directory and the request log. Read this when changing a default, when bringing your own token, or when `check-config` reports a problem.

## Where settings come from

In this order, the first that sets a value wins:

1. command-line flags: `--vault`, `--host`, `--port`, `--token-file`;
2. environment variables: `EVERKEEP_VAULT`, `EVERKEEP_STATE_DIR`, `EVERKEEP_TOKEN`, `EVERKEEP_CONFIG`;
3. the config file;
4. the defaults.

The config file is the one named by `EVERKEEP_CONFIG` (it must exist), else `~/.config/everkeep/config.json` if it exists; without either, flags and environment are all there is. It is JSON. An unknown key is an error, and every path in it must be absolute. [everkeep.example.json](../everkeep.example.json) holds every key with its default:

```json
{
  "vault": "/srv/notes",
  "port": 3100,
  "host": "127.0.0.1",
  "allowed_hosts": [],
  "log_requests": false,
  "max_doc_bytes": 52428800,
  "max_text_bytes": 20971520,
  "extract_timeout_s": 60,
  "cache_max_mb": 512,
  "policy_page": { "mode": "off" }
}
```

## Keys

| Key | Flag / variable | Default | |
|---|---|---|---|
| `vault` | `--vault`, `EVERKEEP_VAULT` | none | The folder the tools work in. Required for `serve` and stdio. |
| `host` | `--host` | `127.0.0.1` | Address to listen on. See [Address and port](#address-and-port). |
| `port` | `--port` | `3100` | HTTP port. |
| `allowed_hosts` | | `[]` | Host names accepted in `Host` and `Origin` on a local address, besides localhost. See [Address and port](#address-and-port). |
| `state_dir` | `EVERKEEP_STATE_DIR` | `~/.local/state/everkeep` | Token and document cache. Must be outside the vault. |
| `log_requests` | | `false` | One log line per HTTP request, see [Request log](#request-log). |
| `max_doc_bytes` | | `52428800` (50 MB) | Larger documents are refused, not read. |
| `max_text_bytes` | | `20971520` (20 MB) | Text extracted from one document, at most. |
| `extract_timeout_s` | | `60` | Time one document may take to extract. |
| `cache_max_mb` | | `512` | Size of the document cache; the least recently used entries go first. |
| `policy_page` | | `{"mode": "off"}` | `{"mode": "ha-ingress", "port": 3101, "users": []}` in the Home Assistant app only. |
| `$comment` | | | Free text, ignored. |

The Docker image sets `EVERKEEP_VAULT=/vault` and `EVERKEEP_STATE_DIR=/data`; a config file mounted into the container uses container paths.

## The state directory

It holds two things: the file `token` and the folder `doc-cache`. Everkeep creates it on start with mode 0700. It must be outside the vault, so that no tool can read the token or the cache; a state directory inside the vault stops the start:

```text
everkeep: state_dir /srv/notes/state is inside the vault /srv/notes: it holds the token and the document cache, which the tools must not reach
```

If it cannot be written, the start stops with a message that names the directory, the user id of the process and the owner of the directory.

## The token

The HTTP server needs a token; stdio does not (the client starts the process itself). Everkeep looks for it in this order:

1. the file named by `--token-file`;
2. the environment variable `EVERKEEP_TOKEN`;
3. the file `token` in the state directory;
4. none found: it generates one and saves it there.

The token is never read from the config file and never taken from the command line itself.

A generated token is 32 random bytes written as 64 hex characters, saved with mode 0600. It is printed once, at the moment it is generated:

```text
everkeep: new token generated and saved to /home/me/.local/state/everkeep/token
everkeep: claude.ai connector path: /private_<token>/mcp
everkeep: Bearer header: Authorization: Bearer <token>
everkeep: shown once; `everkeep token` shows it again
```

`everkeep token` prints the two lines again: the path for claude.ai and the Bearer header. `everkeep token --new` replaces the saved token and prints the new lines; every connected client must then be updated, and a running server keeps the old token until it is restarted.

A token you bring yourself must be at least 32 characters of `A-Z a-z 0-9 . _ ~ -` (it is also part of a URL path). Anything else stops the start, with the hint to use a generated one:

```text
everkeep: token from env EVERKEEP_TOKEN: the token is too short: 5 chars, at least 32 required; run `everkeep token --new` for a generated one
```

The token is never written to any log line except the one at generation, and `check-config` names only where it comes from.

## Address and port

`everkeep serve` listens on `127.0.0.1:3100` by default: only programs on the same computer can reach it. On such a local address it also refuses requests whose `Host` or `Origin` header is not `localhost`, `127.0.0.1` or `[::1]`, with 403; this stops a website open in your browser from reaching the server through a DNS trick.

A tunnel or reverse proxy on the same computer (Tailscale Funnel, Cloudflare Tunnel, Caddy) usually passes your public name in `Host`. Name it in `allowed_hosts` and it is accepted like localhost, in `Host` and in `Origin`; letter case and a port in the header do not matter:

```json
{
  "vault": "/home/me/notes",
  "allowed_hosts": ["notes.example.ts.net"]
}
```

Each entry is a host name or an address, without a scheme, a port or a path; an IPv6 address goes in brackets (`[2001:db8::1]`). Anything else stops the start with a message that names the entry. See [remote access](remote-access.md#without-docker).

With `--host 0.0.0.0` (or another non-local address) it answers on the network, without the `Host` and `Origin` checks: the token alone protects it, the start line says so, and `allowed_hosts` has nothing to do. The Docker image listens on `0.0.0.0` inside the container; `-p 127.0.0.1:3100:3100` keeps it on the computer itself.

The start line on stderr shows what is in force:

```text
everkeep 1.1.0 on 127.0.0.1:3100, vault /home/me/notes, policies off, doclines 0.1.1, allowed hosts notes.example.ts.net
```

## Request log

With `"log_requests": true` every HTTP request produces one line on stderr:

```text
[req] 2026-10-13T10:56:25.478Z 160.79.106.34 POST /private_***/mcp -> 200 172B pv=- ua="Claude-User"
```

Fields: UTC time, client address (`CF-Connecting-IP`, then the first `X-Forwarded-For` address, then the socket address), method, path with the token masked as `/private_***`, status, response size, the `MCP-Protocol-Version` header (`-` when absent), user agent. Refused requests carry `(not found)`, `(unauthorized)`, `(Host not local)` or `(Origin not local)` at the end. How to use it: [troubleshooting](troubleshooting.md#seeing-the-requests).

## `check-config`

```sh
everkeep check-config --vault /home/me/notes
```

```text
everkeep 1.1.0
config file: none (looked in /home/me/.config/everkeep/config.json)
vault: /home/me/notes (flag --vault) — directory
vault case: case-sensitive vault
state dir: /home/me/.local/state/everkeep (default)
listen: 127.0.0.1:3100 (host default, port default)
allowed hosts: none
log_requests: false
policy page: off
limits: max_doc_bytes 52428800, max_text_bytes 20971520, extract_timeout_s 60, cache_max_mb 512
token: /home/me/.local/state/everkeep/token
toolchain:
  pdfinfo: 25.12.0
  pdftoppm: 25.12.0
  sqlite3: 3.53.4
  doclines: 0.1.1

ok
```

It exits with 0 when everything is in order and 1 with a list of problems otherwise. `vault case` says whether the vault's file system ignores letter case; the protection does not depend on it (see [policies](policies.md#letter-case)).
