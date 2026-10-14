# Remote access

claude.ai in the browser, the Claude apps and Claude Desktop's connectors do not talk to your computer directly: Anthropic's servers connect to Everkeep from the internet. So Everkeep needs a public address that starts with `https://`. This page shows three ways to get one: Tailscale Funnel and a Cloudflare Quick Tunnel are free and need no domain and no open port on your router; your own reverse proxy is the third. Read this after the Quick start, before adding the connector in claude.ai.

Claude Code and Claude Desktop with the [stdio setup](installation.md#claude-desktop) run on your own computer and do not need any of this.

The steps assume Everkeep runs in Docker as in the [Quick start](../README.md#quick-start), on port 3100 of this computer. If it runs without Docker, read [Without Docker](#without-docker) as well.

- [Tailscale Funnel](#tailscale-funnel) — a fixed address, for everyday use
- [Cloudflare Quick Tunnel](#cloudflare-quick-tunnel) — one command, an address that changes on every start
- [Your own reverse proxy](#your-own-reverse-proxy) — if you already have a domain and a proxy
- [Adding the connector](#adding-the-connector)

## Tailscale Funnel

[Tailscale](https://tailscale.com) is a free service (Personal plan) that gives each of your devices a name. Its Funnel feature publishes one port of a device on the internet at `https://<device>.<tailnet>.ts.net`, with a certificate, through Tailscale's servers. The address stays the same.

1. **Create an account and install Tailscale** on the computer that runs Everkeep: [tailscale.com/download](https://tailscale.com/download). On Linux:

   ```sh
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```

   `tailscale up` prints a link; open it and sign in. On Windows the installer signs you in.

2. **Publish port 3100.** On Windows, in PowerShell:

   ```powershell
   tailscale funnel --bg 3100
   ```

   On Linux:

   ```sh
   sudo tailscale funnel --bg 3100
   ```

   The first time, Funnel is not switched on for your account yet: the command prints a link. Open it, approve Funnel, and run the command again. `--bg` keeps the setting after the terminal is closed and after a restart.

3. **Read the address:**

   ```sh
   tailscale funnel status
   ```

   It shows the public address, `https://<device>.<tailnet>.ts.net`, and that it points to `http://127.0.0.1:3100`.

To stop publishing: `tailscale funnel --bg 3100 off`.

On macOS, Funnel works with the open-source variant of the Tailscale client only; see Tailscale's [Funnel documentation](https://tailscale.com/kb/1223/funnel). With the App Store app, use the Cloudflare Quick Tunnel.

Funnel accepts HTTPS only, and Tailscale limits its bandwidth; for notes and documents that is enough.

## Cloudflare Quick Tunnel

A Quick Tunnel needs no account at all. Cloudflare gives it a random address under `trycloudflare.com`, and the address changes every time the tunnel starts: after each restart you have to put the new address into the connector. Cloudflare describes Quick Tunnels as meant for testing. Use it to try Everkeep, and Tailscale Funnel or your own domain for every day.

1. **Start the tunnel** next to Everkeep, sharing its network:

   ```sh
   docker run -d --name everkeep-tunnel --network container:everkeep cloudflare/cloudflared:2026.10.0 tunnel --no-autoupdate --url http://localhost:3100
   ```

2. **Read the address** from the tunnel's log, a line with `https://<words>.trycloudflare.com`:

   ```sh
   docker logs everkeep-tunnel
   ```

To stop it: `docker rm -f everkeep-tunnel`. After the `everkeep` container is recreated (an update), remove and start the tunnel again, then update the address in the connector.

For a permanent address with Cloudflare you need a domain added to a Cloudflare account and a named tunnel created in the Cloudflare dashboard, with a public hostname that points at `http://localhost:3100`. See Cloudflare's [tunnel documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/).

## Your own reverse proxy

If you have a domain and a reverse proxy that terminates TLS (Caddy, nginx, a router's domain service), point a hostname at `http://127.0.0.1:3100`. With Caddy:

```text
notes.example.com {
	reverse_proxy 127.0.0.1:3100
}
```

Everkeep speaks plain HTTP; never publish port 3100 itself without TLS in front.

## Without Docker

Without Docker, Everkeep listens on `127.0.0.1` by default and then refuses requests whose `Host` or `Origin` header is not `localhost`, `127.0.0.1` or `[::1]` (a guard against websites in your browser reaching it). Tailscale Funnel, a Cloudflare tunnel and most reverse proxies on the same computer pass the public name in `Host`, so their requests get 403 until you name that public name in `allowed_hosts` in the [config file](configuration.md#where-settings-come-from):

```json
{
  "vault": "/home/me/notes",
  "allowed_hosts": ["notes.example.ts.net"]
}
```

Use the name of your own address, without `https://` and without a port: the `<device>.<tailnet>.ts.net` name of Tailscale Funnel, the hostname of your tunnel or proxy. Restart Everkeep; its start line then ends with `allowed hosts` and the names. Everkeep keeps listening on `127.0.0.1`, so nothing else on your network can reach it.

A Cloudflare Quick Tunnel gets a new name on every start, so `allowed_hosts` would have to change each time; outside Docker use it with `--http-host-header localhost:3100` added to the `cloudflared` command, which makes it pass a local name.

## Adding the connector

1. Show the token: `docker exec everkeep everkeep token`. The first line is `/private_<token>/mcp`.
2. Join your public address and that line: `https://<your public address>/private_<token>/mcp`.
3. In claude.ai: **Settings → Connectors → Add custom connector**, give it a name (for example `Everkeep`) and paste the URL. The connector then appears in Claude Desktop and the Claude apps signed in to the same account.

To check the address from any computer, ask for the tool list:

```sh
curl -s -X POST "https://<your public address>/private_<token>/mcp" -H "Content-Type: application/json" -H "Accept: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

A long JSON answer listing tools means the path works. An empty answer with status 404 means a wrong token in the URL; no answer at all means the tunnel or proxy does not reach Everkeep.

The URL is a password: anyone who has it can read and change your notes. If it leaks, make a new token with `docker exec everkeep everkeep token --new`, restart Everkeep with `docker restart everkeep` (the running server keeps the old token until then), and update the connector.
