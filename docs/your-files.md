# Putting your files in

How to get your own files — notes, contracts, invoices, manuals, exported reports — into the folder Everkeep works on. Read this after the Quick start, or when Everkeep runs on another computer than the one your files are on.

Everkeep sees a file as soon as it is in the folder: no import step, no restart. Folders inside it are fine and help the assistant find things: `contracts/`, `invoices/2026/`, `projects/<name>/`. A file you replace with a new version is read anew the next time it is needed.

## Everkeep on this computer

This is the setup of the [Quick start](../README.md#quick-start): the folder is `everkeep-notes` in your home folder. Open it the way you open any folder:

- **Windows:** type `explorer $HOME\everkeep-notes` in PowerShell, or go to This PC → Users → your name → `everkeep-notes`.
- **macOS:** type `open ~/everkeep-notes` in Terminal, or open your home folder in Finder.
- **Linux:** open your home folder in the file manager.

Then drag files into it, or copy and paste them, as into any other folder.

## Everkeep on another computer or a server

When Everkeep runs on a home server, a NAS or another computer in your network, put the files into its folder over the network. Any of these works; set them up as their own documentation says:

- **A shared network folder.** Share the vault folder on the server, with Samba on Linux or a NAS, or as a shared folder on Windows, and copy files into it from your computer.
- **A sync program.** [Syncthing](https://syncthing.net) or [Nextcloud](https://nextcloud.com) keep a folder on your computer and the vault folder on the server the same.
- **Copying over SSH.** [WinSCP](https://winscp.net) on Windows, or `scp` on macOS and Linux, copies files to the server.

When Everkeep runs in Docker on a Linux server, it works as user id 1000. It can read files you copy in, but it can change or discard them only if that user may write them; see [who owns the folder](installation.md#who-owns-the-folder).

## Home Assistant

The [ha-filesystem-mcp](https://github.com/st412m/ha-filesystem-mcp) app works on the folder set in its option `vault_path`, under `/media` or `/share`. To reach that folder from your computer, install the [Samba share](https://github.com/home-assistant/addons/blob/master/samba/DOCS.md) app of Home Assistant: it shares `media` and `share` on your network, and the vault is the folder inside it named in `vault_path` (for `/media/VAULT`, the folder `VAULT` in the share `media`). Any other app with access to `/media` or `/share` works as well.

## Your files and the write policies

Write policies limit only what the AI does through Everkeep's tools. Files you put in, change or delete yourself — by copying, over a share or with a sync program — are not limited by them.
