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
amby search --tag work --property status=active --folder Projects
amby links 'Meeting'
amby backlinks 'Meeting'
amby tags
amby open 'Projects/Meeting.md'
amby templates
amby daily
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

`search` takes an optional text query and any number of filters. Every filter must
match. `--tag TAG` also matches nested tags (`work` finds `work/review`). `--property
NAME` requires the header key; `--property NAME=VALUE` also requires the value, or
one item of a list, to equal `VALUE`. Names and values ignore case in every script,
so `статус` finds `Статус`. `--folder` keeps the notes inside one visible
folder, and `--limit` caps the results (50 by default). A search needs a query or a
filter.

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

## Templates and daily notes

```sh
amby templates
amby new 'Projects/Standup' --template Meeting
amby daily
amby daily --date 2026-11-20 --template Daily
printf -- '- Called the supplier\n' | amby daily append
```

A template is any Markdown note in the templates folder (`Templates/` unless the
Templates module is set to another, see [vault format](vault-format.md#templates-and-daily-notes)),
named by its path there without `.md` (`Work/Review`); a vault path ending in `.md` works too. `templates` lists
them. `new PATH --template NAME` creates the note from the template instead of from
stdin: the template's own `amby-id` is dropped so the new note gets a fresh one, and
`{{title}}` (the new file name), `{{date}}` (`YYYY-MM-DD`) and `{{time}}` (`HH:MM`,
local time) are filled in everywhere, header included. Everything else, other header
fields and other apps' metadata included, is copied as written. The template is never
changed. A placeholder that makes the header invalid YAML returns
`invalidFrontmatter` and creates nothing.

`daily` opens the note for a day, `Daily/YYYY-MM-DD.md` unless the Daily notes module is
set to another folder, and creates it when it is missing, from `--template` or the
module's template (its `{{title}}` is the date). The flags win over the settings. It reports the
path and `created`. `--date` picks another day and `--folder` another folder (`.` for
the vault root); a missing folder is created by the rules for a new note's path.
`daily append` adds stdin or `--file` at the end, creating the note first if needed.
An existing note is never recreated or replaced; appending to it takes a history
snapshot as `append` does. `--dry-run` previews both. When the Templates or Daily notes
module is switched off in Settings → Modules, its commands return `moduleDisabled`.

## Properties

```sh
amby prop list 'Meeting'
amby prop set 'Meeting' status paused
amby prop set 'Meeting' priority 3 --type number
amby prop set 'Meeting' people Ann Bob
amby prop set 'Meeting' status
amby prop style 'Meeting' status --type select --icon 'amby-icon:circle-chevron-down:' \
  --settings '{"options":["active","paused","done"],"default":"active","colors":{"done":"green"}}'
amby prop rename 'Meeting' status state
amby prop order 'Meeting' state tags
amby prop delete 'Meeting' state
```

A property's value lives in the note's YAML header; its presentation (type, icon and
settings) lives in Amby's property groups, as described in the
[vault format](vault-format.md). `prop list` shows every header key except `amby-*`
with its value, list items, type, icon, settings and whether it comes from the
template of basic properties. Settings are JSON: `options`, `default` and `colors`
(a colour name per option).

`prop set` creates a missing property. Several values make a list, and no value
clears the value. Put `--` before a value that starts with `-`, as in
`amby prop set Meeting delta -- -5`. `--type` gives a new property its type or changes the type of an
existing one; the types are `text`, `number`, `checkbox`, `date`, `select`, `list`
and `url`. `prop style` changes only the presentation and leaves the header bytes as
they are. It needs at least one of `--type`, `--icon` and `--settings`. `prop order`
puts the named properties first, in that order; the others follow.

Every write rewrites only the affected header line, keeps the BOM and line endings,
and takes a history snapshot of the previous note first. A note without `amby-id`
accepts value edits and deletions in its header (no ID is added) but not styling or
renames, which are keyed by the ID. A vault whose properties Amby has not yet
migrated is read-only until the desktop opens it once. When desktop Amby has the
vault open, property writes run in the app, which refreshes its properties panel.

## Links, orphans and note info

```sh
amby info 'Plan'
amby orphans --folder Projects
amby unresolved
```

`info` summarizes a note: path, ID, size, words, dates, tags, outgoing, incoming and
unresolved link counts, the number of properties, and attachments (with how many are
missing). `orphans` lists notes no other note links to. `unresolved` lists links to
notes that do not exist, with the note that holds each; a wiki embed of an existing
file is not unresolved. Both take `--folder` and `--limit`.

## Attachments

```sh
amby attachments 'Plan'
amby attach 'Plan' ~/Downloads/report.pdf
amby attach 'Plan' ~/Pictures/chart.png --name 'Q3 chart.png' --no-link
```

`attachments` lists the local files a note refers to: Markdown links and images
(resolved next to the note first, then from the vault root), including missing ones,
and wiki embeds of files that exist. External URLs are not attachments. Each entry has
a vault-relative path, a kind (`image`, `pdf`, `audio`, `video` or `file`), whether it
exists and its size.

`attach` copies a file into the note's assets folder under a new random name, as the
editor does, and appends a link to the note (an image is embedded). It never replaces
a file, takes a history snapshot of the note, and leaves the source in place. `--name`
sets the display name and `--no-link` copies without editing the note. Files over
100 MB are refused.

## Bulk edits

```sh
amby bulk set status archived --tag 2025 --dry-run
amby bulk set status archived --tag 2025 --yes
amby bulk move Archive --folder Inbox --property status=done --yes
```

`bulk set NAME [VALUE]...` sets a property and `bulk move FOLDER` moves notes, with
link updates, for every note the filters find. The filters are those of `search`
(`--tag`, `--property`, `--folder`) plus `--query TEXT`; at least one is required. A
bulk edit needs `--dry-run` to list the notes or `--yes` to run, and touches at most
200 notes (`tooManyNotes` otherwise). Each note is changed on its own: a failed note
does not stop the others, and the result lists every note with its error. The command
then exits with code 8.

## Structural operations

```sh
amby rename 'Projects/Meeting.md' 'Planning' --dry-run
amby rename 'Projects/Meeting.md' 'Planning'
amby move 'Projects/Planning.md' 'Planning Notes'
amby archive 'Planning Notes/Planning.md'
amby archive list
amby restore 'Planning Notes/Planning.md'
amby delete 'Planning Notes/Old.md' --dry-run
amby delete 'Planning Notes/Old.md'
amby recover
```

Supply vault-relative paths. Rename takes a new stem for a file or a new
name for a folder. Move takes an existing folder or `.` for the vault root.
Rename and move update affected links and include the sidecars of a note
bundle. A rewritten wikilink keeps the form it was written in: a link by name stays a
name (`[[Meeting]]` becomes `[[Planning]]`) when the new name means this note alone,
and a link by path gets the new path. When the name would be ambiguous, the full path
is written so the link keeps pointing at the same note. Archive moves an item and its contents into the vault archive. Restore
takes an archive-relative path and chooses a free name if the original location
is occupied.

When desktop Amby has the selected vault open, the CLI sends structural writes
to that app instance through a [local connection](cli-ipc.md) for the same
user and profile. If Amby holds the lease for a vault that is no longer active,
switch to that vault or close the app before running a structural write.

`delete` moves a note, bundle or folder to the operating system's trash, where it
can be restored. A note inside a bundle takes the whole bundle. `delete --dry-run`
lists the item and the notes it would remove. The CLI never deletes permanently: if
the system trash cannot take the item, nothing is removed and the command returns
`trashUnavailable`, so use `archive` instead.

`archive list` and `--dry-run` are read-only. A preview reports the proposed
destination and rewritten paths. An interrupted operation resumes before the
next structural write, through `amby recover`, or when the desktop opens the
vault. When delegated to the desktop, `amby recover` resumes the structural
journal. If a path changed during an interruption, recovery keeps the current
files and the journal and returns `recoveryRequired`. If the desktop connection
is lost after dispatch, the CLI returns `desktopRequestInterrupted`. Check the
vault before repeating the command.

## Scripts and agents

Every command takes `--json`, so scripts and agents with a shell can chain the CLI and
process results locally instead of sending each note through a model. For example,
tag every note that links to a missing note, or collect today's open questions:

```sh
amby --json unresolved | jq -r '.data.links[].source' | sort -u |
  while read -r note; do amby prop set "$note" review needed; done
amby --json search --tag question --folder Inbox | jq -r '.data.results[].path'
```

This gives an agent with a terminal the benefit of MCP "code mode": loops and filters
run in the shell, and only the result reaches the model. Writes keep their usual
safeguards (history snapshots, the write lock, desktop delegation), and `--dry-run`
previews them. For many notes at once prefer `bulk`, which checks each note and
reports every one.

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
| 3    | Vault, note, folder or property absent                |
| 4    | More than one note or header key matches              |
| 5    | The requested path is outside the visible vault       |
| 6    | Path collision or conflicting edit                    |
| 7    | Vault is busy or automatic recovery could not finish  |
| 8    | A bulk edit ran, but some notes failed                |

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

The stdio server exposes read tools for notes, tags, properties, the archive,
databases and workshops, and lists notes as resources. Add `--allow-write=Projects/` after `mcp` for a folder grant or
`--allow-write` for the visible vault. The [MCP tool contract](mcp.md) lists
arguments, previews, revisions, grants and error codes. Complex mutations
reuse the desktop's local IPC connection when Amby owns the vault lease.
