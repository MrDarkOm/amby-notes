# Vault format and compatibility policy

## Ownership and source of truth

Markdown files and attachments in the selected vault belong to the user and
remain the source of truth. Amby may rebuild its SQLite index from those files;
deleting the index must not delete or change notes.

Amby never writes `.obsidian/`, `.git/`, `.trash/`, or `assets/` while indexing.
Those directories, along with `.amby/`, are excluded from the note index.

## `.amby/`

`.amby/` is Amby's per-vault metadata directory. It may contain:

- `notes.db` — rebuildable SQLite index for note metadata, links, tags, and
  search. It is never the only copy of note content.
- `blocks/<note-id>.json` — per-note UI block sidecars.
- `properties.json` — versioned custom-property metadata keyed by stable note ID;
  SQLite mirrors it for queries, while this sidecar makes the data rebuildable.
- `recovery/` — versioned crash-recovery journal for editor and canvas drafts
  that have not reached the filesystem yet, keyed by stable note ID or canvas path.
- future versioned, documented metadata files.

The directory is application metadata, not an Obsidian configuration directory.
Amby must not change `.obsidian` settings or plugin data.

## Frontmatter `id`

Amby's service identifier is the top-level YAML field `id`. A valid Amby ID is
a canonical uppercase ULID: exactly the string produced by the ULID library
(for example, `01J1K2M3N4P5Q6R7S8T9V0WXYZ`). It is stable across rename and
move operations.

An existing `id` with any other format is treated as user-managed. Amby leaves
it unchanged and reports the conflict during indexing. If the same valid Amby
ULID is present in multiple files, Amby indexes only the first deterministic
path and reports every other conflict without changing source files.

Adding or repairing IDs for an existing vault is a separately confirmed
migration: it needs a read-only preflight report, backup, preview, journal, and
rollback path. Amby never silently replaces an existing frontmatter `id`.

### ID migration recovery

An ID migration creates its versioned journal in `.amby/migrations/` before it
creates a backup or changes a note. The journal contains the complete planned
file list, a generated ID for each file, a vault-relative backup root, and
durable per-file progress (`pending`, `backupCreated`, `applied`, or
`rolledBack`). Journal writes are atomic and sync both the journal and its
parent directory.

For every planned note Amby publishes a no-replace raw-byte backup first,
records that backup, atomically writes the ID, and then records that the note
was applied. A journal is marked `completed` only after every file is applied.
On the next vault-open attempt an incomplete (`planned` or `inProgress`)
journal is surfaced before indexing; the user may resume it, roll it back, or
inspect it without opening the vault. Resume recognises a note that already
has its planned ID when a crash occurred between the note write and the journal
update. Rollback restores raw backup bytes only when the current note still
has the planned migration ID; later user edits cause recovery to stop rather
than overwrite them. Both resume and rollback are idempotent.

## Compatibility invariant

No Amby operation may make a note, attachment, Canvas, or Excalidraw file
unusable in Obsidian. Unknown content must be preserved until M2's lossless
document model is complete.

## Saving text files

Text writes use a sibling temporary file, flush it to disk, and then atomically
rename it over the target. A failed write removes its temporary file and never
truncates the original note. Existing UTF-8 BOM and the dominant line-ending
style (LF or CRLF) are preserved. Amby refuses to rewrite a non-UTF-8 text file
through the text editor rather than silently changing its encoding.

Creation uses a separate no-replace publication path: a file or attachment
cannot replace a path that appeared after Amby checked whether a name was free.
The preferred publish primitive links a fully synced sibling temporary file. On
filesystems that do not support hard links (including common FAT/exFAT and some
network configurations), Amby instead reserves the final path with `create_new`,
streams the synced temporary bytes into that reservation, and removes both
temporary and failed reservation on error. Neither path uses an overwriting
rename. Attachment imports enforce product limits (100MB disk files, 25MB
clipboard payloads), sanitize stems and extensions (ASCII alphanumeric only,
preventing directory traversal), and classify SVGs as non-inline file attachments.

Autosave work is serialized per file. A completed older write cannot clear the
unsaved state of a newer in-memory buffer, and a stale queued buffer is skipped.

## External changes

Changes from outside Amby are coalesced during short filesystem bursts and then
re-indexed. Clean open documents reload automatically. If an open document has
unsaved edits, autosave is paused and Amby presents both versions: the user can
accept the external text, explicitly save the local text, or create a manual
merge buffer. A uniquely named sibling copy (`Name.<random-id>-conflict.md`)
can preserve the local text before
accepting an external version. An externally deleted open document is never closed silently; its
local version can be restored by an explicit save.

## Local history

Before Amby replaces an existing note or text file, it stores the original raw
bytes in `.amby/history/`. Snapshots preserve BOM and line endings exactly and
include the original byte count plus an integrity hash; a damaged version is
never restored silently. A versioned `.amby/history/manifest.json` is the
authoritative snapshot metadata index, so opening one note's history does not
scan every metadata JSON file. Older per-snapshot JSON metadata is imported once
when the manifest is first needed; it may remain on disk as harmless legacy
metadata.

History is append-only and is **not automatically pruned**. The History panel
shows per-note and vault-wide version counts and storage use. Its explicit
cleanup action previews the number of versions and bytes to remove, requires
confirmation, and currently retains the 20 latest snapshots of every note.
Cleanup moves a snapshot into a staged location, atomically updates the
manifest, and only then deletes the staged data. A versioned cleanup journal
restores or completes an interrupted operation before history is used again.
This history is application metadata; the Markdown vault remains the source of
truth.

Deletes made through Amby are moves to `.amby/trash/`, including Canvas,
Excalidraw, and database layers. They remain restorable from the History panel
and are never delegated solely to an OS recycle bin that may be emptied outside
the app.

## Recovery journal

In-flight editor and canvas edits that have not reached the filesystem are
persisted in `.amby/recovery/`. Each recovery entry is a versioned JSON document
storing the vault generation, document kind, stable note ID or canvas path,
current path hint, timestamp, content text, and a non-cryptographic content hash.

Writes use atomic no-truncate publication. Draft entries are subject to per-entry
size limits (5 MB), vault-wide storage caps (50 MB), entry count limits (100
entries), and a 14-day TTL. On startup and vault activation, expired or corrupted
entries are automatically swept, and quota limits are enforced by pruning the
oldest drafts. When opening a document with an unpersisted draft differing from
the on-disk version, Amby prompts the user to restore the recovered text.

## Backup and Git policy

Local history protects against accidental application actions and failed saves;
it is not a substitute for a second physical copy. A protected vault should be
backed up by the operating system or a sync service with version history.

Git is a useful optional third layer for Markdown-first vaults: initialise it
only with the user's explicit choice, commit the user-visible note and asset
files, and keep `.amby/` ignored because it contains rebuildable indexes and
local recovery data. Amby must not silently initialise repositories, create
commits, rewrite history, or push to a remote: each can conflict with a user's
existing workflow and is itself a data-changing operation.

## Rename and move

For notes that Amby renames or moves, resolved inbound wikilinks are rewritten
to the new vault-relative target. Aliases and heading/block anchors are kept.
Only links resolved by the SQLite index to the moved note are changed, avoiding
unsafe rewrites of ambiguous text. Each changed source note is snapshotted
before the refactor; if a link rewrite fails, already rewritten source notes
are restored to their pre-refactor text.

A rename that changes only letter case is a real filesystem mutation. Amby
first verifies that the requested spelling resolves to the same filesystem
entry (rather than a distinct colliding file), then renames through a unique
sibling temporary path and rolls back if the final step fails. Bundle container,
main Markdown file, Canvas and Excalidraw sidecars follow the same two-step
path so they cannot be left with mixed names on case-insensitive filesystems.
