# Amby CLI

## Installation

The desktop installer includes the standalone CLI. Its location depends on the
package.

- On macOS, use `/Applications/Amby.app/Contents/MacOS/amby` if Amby is in
  Applications. To put it on your shell's PATH, link it into a directory
  already on PATH, such as `~/.local/bin`.
- On Windows, run `amby.exe` from the folder that contains the installed
  Amby executable. Add that folder to your user PATH for use from any folder.
- On Linux, packages with installed executables include `amby`. For an AppImage
  use `./Amby.AppImage --amby-cli --help`; the `--amby-cli` argument runs the
  CLI inside the image and passes through the remaining arguments and stdio.

For developers, `npm run build:desktop` builds the app and the bundled CLI
for the same target and profile. Build or install the standalone binary from
the repository root with Cargo if you only need the CLI.

```sh
cargo build --locked -p amby-cli
target/debug/amby --help
cargo install --locked --path crates/amby-cli
```

## Commands

```sh
amby --vault /path/to/vault ls
amby vault list
amby vault use /path/to/vault
amby ls Projects
amby cat 'Projects/Meeting.md'
amby search --json 'meeting agenda'
amby links 'Meeting'
amby backlinks 'Meeting'
amby tags
amby open 'Projects/Meeting.md'
```

Vault selection uses `--vault`, then `AMBY_VAULT`, then the CLI default from
`vault use`, then the last vault recorded by the desktop app. `vault use` writes
only the CLI preference in the desktop's per-user app data directory. Set
`AMBY_APP_DATA_DIR` to use a separate settings directory, for example in tests.

Use a vault-relative Markdown path, a note title, or an `amby-id` to name a note.
An exact path disambiguates duplicate titles and IDs. The title is the Amby
title, the first H1 or the filename stem, in that order. The CLI uses the
desktop's search, tag and link rules. If there is a usable index snapshot, it
checks the exact set of visible notes and their size and modification stamps.
Otherwise it reads the Markdown into a temporary in-memory catalog. Neither
path writes an index or assigns identities. Notes without IDs can have temporary
path-based keys in the results.

`open` asks the desktop app to navigate to the note through its regular vault
activation and save flow. The CLI reports successful dispatch. Set
`AMBY_DESKTOP_BIN` to the executable path for development builds. Installed
builds are found next to the CLI, via LaunchServices on macOS, or on PATH on
other platforms.

## Editing notes

```sh
printf '# Meeting notes\n' | amby new 'Projects/Meeting'
printf 'Decisions\n' | amby append 'Projects/Meeting.md'
amby write 'Projects/Meeting.md' --file new-body.md --dry-run
amby write 'Projects/Meeting.md' --file new-body.md
```

All three commands take UTF-8 from stdin or `--file`. A new note takes a
vault-relative path in an existing folder, adds `.md` when needed, and creates
a new `amby-id`. It fails if that path already exists or if the supplied source
has an `amby-id`. Use `append` or `write` with a path, title, or ID for an
existing note. `append` begins on a new line when the source ends without one.
`write` replaces the Markdown body and expects input without a frontmatter
header. A complete existing envelope and BOM are kept byte for byte. Inserted
lines use the original body’s line-ending convention, or the envelope’s
convention when the body has no line endings.

A changed existing note gets a byte-exact history snapshot before publication,
including when automatic history is disabled. CLI snapshots carry `cli-edit`.
A no-op creates no snapshot. `--dry-run` prints a unified diff and creates
neither notes nor metadata. A new note’s confirmed write generates its own ID.
When desktop Amby is open, an edit from the CLI arrives as an external change.
The normal conflict flow protects unsaved edits. A conflicting write returns
`revisionConflict` so the caller can read the latest bytes and retry.

## Structural operations

```sh
amby rename 'Projects/Meeting.md' 'Planning' --dry-run
amby rename 'Projects/Meeting.md' 'Planning'
amby move 'Projects/Planning.md' 'Planning Notes'
amby archive 'Planning Notes/Planning.md'
amby archive list
amby restore 'Planning Notes/Planning.md'
amby recover
```

Supply vault-relative paths. Rename takes a new stem for a file or a new
name for a folder. Move takes an existing folder or `.` for the vault root.
Rename and move update affected links and include the sidecars of a note
bundle. Archive moves an item and its contents into the vault archive. Restore
takes an archive-relative path and chooses a free name if the original location
is occupied.

When desktop Amby has the selected vault open, the CLI sends structural writes
to that app instance through a [local connection](cli-ipc.md) for the same
user and profile. If Amby holds the lease for a vault that is no longer active,
switch to that vault or close the app before running a structural write.

`archive list` and `--dry-run` are read-only. A preview reports the proposed
destination and rewritten paths. An interrupted operation resumes before the
next structural write, through `amby recover`, or when the desktop opens the
vault. When delegated to the desktop, `amby recover` resumes the structural
journal. If a path changed during an interruption, recovery keeps the current
files and the journal and returns `recoveryRequired`. If the desktop connection
is lost after dispatch, the CLI returns `desktopRequestInterrupted`. Check the
vault before repeating the command.

## JSON and exit codes

`--json` emits one object on stdout. A success has `data`. An error has a stable
`error.code` and a list of relative `error.candidates` when the note is ambiguous.

```json
{
  "schemaVersion": 1,
  "ok": false,
  "error": { "code": "ambiguousNote", "candidates": ["A/Meeting.md", "B/Meeting.md"] }
}
```

| Exit | Meaning                                               |
| ---- | ----------------------------------------------------- |
| 0    | Success                                               |
| 1    | Read, preferences, desktop dispatch or output failure |
| 2    | Invalid invocation or missing vault                   |
| 3    | Vault, note or folder absent                          |
| 4    | More than one note matches                            |
| 5    | The requested path is outside the visible vault       |
| 6    | Path collision or conflicting edit                    |
| 7    | Vault is busy or automatic recovery could not finish  |

Without `--json`, `cat` emits the original UTF-8 bytes, including the BOM, line
endings and any final newline. Other commands emit human-readable text.
Terminal help and errors support English and Russian through the locale
environment.

## MCP

Configure a local stdio MCP server with command `amby` and arguments
`["--vault", "/path/to/vault", "mcp"]`. For example, a client configuration
with an `mcpServers` object can use:

```json
{
  "mcpServers": {
    "amby": {
      "command": "/absolute/path/to/amby",
      "args": ["--vault", "/path/to/vault", "mcp"]
    }
  }
}
```

Use the absolute bundled executable path as `command` if `amby` is outside PATH.
For an AppImage, use its path as `command` and put `--amby-cli` first in `args`.

The stdio server exposes read tools for notes, the archive, databases and
workshops. Add `--allow-write=Projects/` after `mcp` for a folder grant or
`--allow-write` for the visible vault. The [MCP tool contract](mcp.md) lists
arguments, previews, revisions, grants and error codes. Complex mutations
reuse the desktop's local IPC connection when Amby owns the vault lease.
