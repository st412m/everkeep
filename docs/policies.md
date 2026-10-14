# Write policies

How to restrict writing in parts of the vault: the `.vault-policy` marker, its fields and modes, `everkeep policy`, the trash, auto-purge, and what happens when a marker is broken. Read this before switching on any restriction, or when a write is refused and you want to know why.

## Default: none

With no markers anywhere, every tool may write anywhere in the vault. Nothing is switched on by installing or updating Everkeep.

## The marker

A policy is a JSON file named `.vault-policy` in a directory. It applies to that directory and everything below it, until a deeper marker is met. Inheritance is per field: a deeper marker that sets only `overwrite` keeps the trash and auto-purge from above.

| Field | Values | Default without any marker |
|---|---|---|
| `readonly` | `true` / `false` | `false` |
| `overwrite` | `"rev"`, `"never"`, `"free"` | `"free"` |
| `trash` | a single directory name, or `null` for no trash | `null` |
| `retention_enabled` | `true` / `false` | `false` |
| `retention_days` | whole number, 1–3650 | 30 |
| `_` | free text, ignored | |

Any other field is an error, and so is a wrong type or value (see [If a marker breaks](#if-a-marker-breaks)).

Markers are read on every tool call, with no cache between calls, so a change applies to the next call.

A directory reached through a symlink inside the vault follows the policy of the place the symlink points to, and that place's trash. The policy line in a listing then ends with where the path resolves:

```text
Policy: read-only, no trash (deletion not available) — inherited from /vault/raw/.vault-policy (via symlink: resolves to /vault/raw/ha)
```

## Modes

| Mode | Fields written | Effect |
|---|---|---|
| `readonly` | `readonly: true`, `overwrite: "never"` | no writes, edits, moves in or out, or discards; reading is unaffected |
| `rev` | `overwrite: "rev"` | new files are free; changing, moving out or discarding an existing file requires its current `rev` |
| `never` | `overwrite: "never"` | new files are free; existing files cannot be changed, moved out or discarded |
| `free` | `overwrite: "free"` | no checks |

`rev` is the mode for notes the assistant maintains: nothing can overwrite a page it has not read. The `rev` is an 8-hex content hash. It comes back from `grep_files`, `read_text_file` with `offset`, `get_file_info`, `write_file` and `edit_file`. A missing or stale `rev` is refused, nothing is written, and the refusal states the current `rev` so the retry can succeed.

## Setting a policy

The assistant cannot change policies: MCP tools refuse to create, change, move or discard anything named `.vault-policy`, in any letter case, including a directory of that name anywhere in a path. You set them on the server with `everkeep policy`; in the Home Assistant app, on the Vault policies page in the sidebar. Both write the same bytes.

`DIR` is absolute or relative to the vault root; the vault comes from `--vault`, `EVERKEEP_VAULT` or the config file. In Docker, prefix the commands with `docker exec everkeep`.

```sh
everkeep policy set wiki --mode rev --trash --purge-days 30 --vault /home/me/notes
```

```text
Saved: /home/me/notes/wiki/.vault-policy
Policy: overwrite=rev, trash=.vault-trash, auto-purge after 30 d — own marker (/home/me/notes/wiki/.vault-policy)
```

`set` takes `--mode readonly|rev|free|never`, and optionally `--trash [NAME]` or `--no-trash`, and `--purge-days N` or `--no-purge`. What you do not give keeps the value in force at that directory.

`everkeep policy show [DIR]` prints the policy in force at `DIR` (default: the vault root) and every marker at and below it:

```text
Policy: none — unrestricted (no .vault-policy marker above this directory).

Markers at and below /home/me/notes:
Policy: read-only, no trash (deletion not available) — own marker (/home/me/notes/raw/.vault-policy)
Policy: overwrite=rev, trash=.vault-trash, auto-purge after 30 d — own marker (/home/me/notes/wiki/.vault-policy)
```

`everkeep policy clear DIR` removes the marker of `DIR`; the directory follows the rule above it again:

```text
Marker removed: /home/me/notes/wiki/drafts/.vault-policy — this directory now follows the rule above it.
```

Invalid input never writes anything.

### A subdirectory shares the trash above it

A marker holds only what its directory sets itself. Setting a mode on `wiki/drafts` below `wiki`, which has a trash, writes only the mode; `wiki/drafts` keeps discarding into the trash of `wiki`, and its listings say so:

```sh
everkeep policy set wiki/drafts --mode free --vault /home/me/notes
```

```text
Saved: /home/me/notes/wiki/drafts/.vault-policy
Policy: overwrite=free, trash=.vault-trash in /home/me/notes/wiki, auto-purge after 30 d — own marker (/home/me/notes/wiki/drafts/.vault-policy)
```

For a trash of its own, name it: `everkeep policy set wiki/drafts --mode free --trash .drafts-trash`. Auto-purge belongs to the directory that owns the trash. `--no-trash` below a directory with a trash switches discarding off for the subdirectory.

## Trash

There is no delete. `trash_file` moves a file into the trash of its zone, `.vault-trash` by default. The path is kept relative to the directory that owns the trash, and the arrival time is stamped into the name in UTC:

```text
wiki/system/foo.md  →  wiki/.vault-trash/system/foo__trash-20260905T050121Z.md
```

A second file with the same name and stamp gets `-1`, `-2` and so on after the stamp. `move_file` out of the trash restores a file.

- A zone with no trash configured cannot discard anything.
- A read-only zone cannot discard anything.
- Directories are not discarded as a unit: trash the files inside one by one.
- `move_file` into a trash directory is refused; use `trash_file`.
- Trash contents are excluded from `grep_files`, `search_files`, `directory_tree` and `read_multiple_files`. They stay readable by explicit path with `read_text_file`.
- `list_directory` and `list_directory_with_sizes` flag a directory that looks like a trash but that no policy in force claims, and leave it alone.

## Auto-purge

Off by default, set per zone on the marker that defines the trash. When enabled, Everkeep erases files older than `retention_days` from that zone's trash: once shortly after start, then once a day. Age is read from the stamp in the name, not from the file's time.

- Files are removed one at a time, and emptied directories with `rmdir`. There is no recursive delete anywhere in Everkeep.
- A file whose name has no stamp is never touched: it was put there by hand.
- Only the zone that owns the trash purges it; a child zone that inherits the trash does not.
- Each sweep writes a `[retention]` summary line to the log.
- It runs in the HTTP server and in stdio mode alike.

Before enabling it, check how the vault is backed up. If the backup is a mirror with no history (for example `rsync --delete` without `--backup-dir`), a purged file disappears from the backup at its next run.

## Order of checks

A refusal names the first rule that applies. The policy checks run from hardest to softest:

1. The path is inside the vault.
2. No part of the path is named `.vault-policy`.
3. The zone's marker chain is readable.
4. The zone is not read-only.
5. For `trash_file`, the zone has a trash.
6. `overwrite: "never"` or `"rev"` for existing files.
7. Only then the content, such as whether `oldText` is present.

So a read-only zone refuses an edit without looking at the file.

## If a marker breaks

A `.vault-policy` that is not valid JSON, has an unknown field or a bad value, or is a directory or symlink instead of a file, **locks its zone**. No writes, no deletion; reading keeps working. The listing tools print `⚠ Policy: BROKEN MARKER — zone locked (read-only, no deletion).` followed by the file and the reason.

The lock covers the whole subtree, including directories with valid markers of their own, and a broken marker does not fall back on its parent's rule. A broken marker at the vault root therefore locks the entire vault, and the assistant cannot even write its own log. Fix the marker first: with `everkeep policy set` or `clear`, on the Vault policies page, or by fixing the file on disk.

## Letter case

The names `.vault-policy`, `.vault-trash` and a zone's own trash name are compared without regard to letter case, on every file system: `.VAULT-POLICY` is refused like `.vault-policy`. Two paths that differ only in case are compared by the file they lead to. So a vault on a file system that ignores case (exFAT or NTFS disks, a Windows or macOS folder mounted into Docker, ext4 with casefold) keeps its policies and its trash.

## What a policy does not cover

Policies stop Everkeep's tools and nothing else. You, a file share, a sync job or a script on the server write straight to the filesystem and never see a marker. A read-only `raw/` constrains the assistant while your own sync jobs keep working.
