# Installation

The ways to run Everkeep: the published Docker image, Node.js on Linux, the Home Assistant app, and how to connect Claude Desktop, Claude Code, Cursor and other clients. Read this when installing, or when moving from one setup to another.

- [Docker](#docker)
- [Linux without Docker](#linux-without-docker)
- [Home Assistant](#home-assistant)
- [Claude Desktop](#claude-desktop)
- [Claude Code](#claude-code)
- [Other clients](#other-clients)
- [Checking the setup](#checking-the-setup)

## Docker

The image `ghcr.io/st412m/everkeep` is published for linux/amd64 and linux/arm64. It holds Node 22 on Alpine, poppler and sqlite, and Everkeep installed from npm; it is about 340 MB. It runs `everkeep serve --host 0.0.0.0 --port 3100` as the user `node` (user id 1000), with:

- the vault at `/vault` — bind-mount your notes folder there;
- the state directory at `/data` — a volume that keeps the token and the document cache across updates.

The commands for Windows, macOS and Linux are in the README's [Quick start](../README.md#quick-start); how to get your files into the folder is in [putting your files in](your-files.md). With Docker Compose, copy [compose.example.yaml](../compose.example.yaml) to `compose.yaml`, change `/srv/notes` to your folder, then:

```sh
docker compose up -d
docker compose exec everkeep everkeep token
```

### Who owns the folder

Everkeep writes into the vault as user id 1000. With Docker Desktop on Windows and macOS this does not matter: the shared folder is writable. On Linux it does. Check your own id:

```sh
id -u
```

If it prints `1000`, the Quick start works as it is. If it prints another number, run the container as yourself and keep its state in a folder you own as well, because `/data` must belong to the same user:

```sh
mkdir -p ~/everkeep-notes ~/.local/state/everkeep-docker
docker run -d --name everkeep --restart unless-stopped --user "$(id -u):$(id -g)" -p 127.0.0.1:3100:3100 -v "$HOME/everkeep-notes:/vault" -v "$HOME/.local/state/everkeep-docker:/data" ghcr.io/st412m/everkeep:1.0.0
```

In `compose.example.yaml` the same is the `user:` line plus a `/data` that belongs to that user. If `/data` is not writable, the server stops at start with a message that names the directory and the user id.

### Updating

The version is part of the image name. To move to a new version, remove the container and start it again with the new tag; the token and the cache stay in the `everkeep-data` volume, your notes in your folder:

```sh
docker rm -f everkeep
docker run -d --name everkeep --restart unless-stopped -p 127.0.0.1:3100:3100 -v "$HOME/everkeep-notes:/vault" -v everkeep-data:/data ghcr.io/st412m/everkeep:1.0.0
```

### Building the image yourself

The repository's `Dockerfile` builds the same image from npm. It needs Docker 23 or later (BuildKit):

```sh
docker build -t everkeep:1.0.0 .
```

To build from a tarball made by `npm pack`, put the tarball next to the `Dockerfile` and name it in the build argument `EVERKEEP_TARBALL`:

```sh
docker build --build-arg EVERKEEP_TARBALL=everkeep-1.0.0.tgz -t everkeep:1.0.0 .
```

## Linux without Docker

You need Node.js 22.17 or later, `pdfinfo` and `pdftoppm` (package `poppler-utils`) and `sqlite3`. On Debian and Ubuntu:

```sh
sudo apt install poppler-utils sqlite3
```

Run it with npx; npm downloads the package on the first run:

```sh
npx --yes --package=everkeep everkeep serve --vault /home/me/notes
```

On the first start it creates the token and prints it once, with the claude.ai path and the Bearer line. `npx --yes --package=everkeep everkeep token` shows it again.

### A permanent command, and CPUs without AVX

The PDF library Everkeep uses has an optional native part, `@napi-rs/canvas`, that Everkeep does not need. On a CPU without AVX (some Celeron, Atom and Pentium models) it crashes the process with "Illegal instruction". Check your CPU:

```sh
grep -o -m1 avx /proc/cpuinfo
```

If this prints nothing, install without the optional part. `npm install -g` installs it even with `--omit=optional`, so install into a folder of its own and link the command:

```sh
npm install --prefix ~/.local/lib/everkeep --omit=optional --no-package-lock everkeep@1.0.0
mkdir -p ~/.local/bin
ln -s ~/.local/lib/everkeep/node_modules/.bin/everkeep ~/.local/bin/everkeep
```

This is also the way to get a permanent `everkeep` command on any CPU. For npx on such a CPU, add the setting in front: `npm_config_omit=optional npx --yes --package=everkeep everkeep serve --vault /home/me/notes`. On a CPU with AVX, `npm install -g everkeep` works as well.

### As a service

To keep it running, make a systemd user service. Create the token first, so that it is shown in your terminal and not in the service log:

```sh
everkeep token --new
```

Then save this as `~/.config/systemd/user/everkeep.service`, with your vault path:

```ini
[Unit]
Description=Everkeep MCP server

[Service]
ExecStart=%h/.local/bin/everkeep serve --vault %h/notes
Restart=on-failure

[Install]
WantedBy=default.target
```

and start it:

```sh
systemctl --user daemon-reload
systemctl --user enable --now everkeep
loginctl enable-linger "$USER"
```

The last line keeps it running when you are not logged in.

## Home Assistant

The [ha-filesystem-mcp](https://github.com/st412m/ha-filesystem-mcp) app runs Everkeep inside Home Assistant OS or Supervised. Its vault is a directory under `/media` or `/share`, its token is shown on the app's Configuration tab, and it adds the Vault policies page to the sidebar. Install and options: the app's documentation.

## Claude Desktop

Claude Desktop starts a local server itself and talks to it over stdio, so no address and no token are needed. On Windows and macOS, Everkeep runs in Docker for this; Docker Desktop must be running.

1. Download the image once, so that Claude Desktop does not wait for it:

   ```sh
   docker pull ghcr.io/st412m/everkeep:1.0.0
   ```

2. In Claude Desktop open **Settings → Developer → Edit Config**. This opens `claude_desktop_config.json` (on Windows in `%APPDATA%\Claude\`, on macOS in `~/Library/Application Support/Claude/`).
3. Add Everkeep to `mcpServers` and put your notes folder before `:/vault`.

   macOS:

   ```json
   {
     "mcpServers": {
       "everkeep": {
         "command": "docker",
         "args": ["run", "-i", "--rm", "-v", "/Users/me/everkeep-notes:/vault", "-v", "everkeep-data:/data", "ghcr.io/st412m/everkeep:1.0.0", "everkeep"]
       }
     }
   }
   ```

   Windows (every `\` in the path is written twice):

   ```json
   {
     "mcpServers": {
       "everkeep": {
         "command": "docker",
         "args": ["run", "-i", "--rm", "-v", "C:\\Users\\me\\everkeep-notes:/vault", "-v", "everkeep-data:/data", "ghcr.io/st412m/everkeep:1.0.0", "everkeep"]
       }
     }
   }
   ```

4. Quit Claude Desktop completely and start it again.

The last word, `everkeep` with no command, runs the stdio server. It can share the folder and the `everkeep-data` volume with an HTTP container started from the Quick start. Claude Desktop on Linux runs it without Docker: `"command": "npx"` with `"args": ["--yes", "--package=everkeep", "everkeep", "--vault", "/home/me/notes"]`.

If the tools do not appear, Claude Desktop's log is in `%APPDATA%\Claude\logs` or `~/Library/Logs/Claude`, in the file `mcp-server-everkeep.log`.

## Claude Code

Over HTTP, to a server that is already running:

```sh
claude mcp add --transport http everkeep http://127.0.0.1:3100/mcp --header "Authorization: Bearer <token>"
```

Or on stdio, started by Claude Code itself (Linux):

```sh
claude mcp add --transport stdio everkeep -- npx --yes --package=everkeep everkeep --vault /home/me/notes
```

## Other clients

A client that speaks MCP Streamable HTTP needs the URL and one header:

- URL: `http://127.0.0.1:3100/mcp` on the same machine, or your HTTPS address followed by `/mcp`;
- header: `Authorization: Bearer <token>`.

A client that cannot send headers uses the secret path instead: `https://<your-host>/private_<token>/mcp`.

Cursor, in `~/.cursor/mcp.json` or a project's `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "everkeep": {
      "url": "http://127.0.0.1:3100/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

## Checking the setup

```sh
everkeep check-config --vault /home/me/notes
```

prints the settings in force and where each comes from, the state directory, where the token comes from (never the token itself), and the versions of `pdfinfo`, `pdftoppm`, `sqlite3` and doclines; it ends with `ok` or a list of problems. In Docker: `docker exec everkeep everkeep check-config`.
