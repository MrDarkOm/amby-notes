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
are pruned to at most 30 versions per source file and 200 MiB in total. This
history is application metadata; the Markdown vault remains the source of truth.

## Rename and move

For notes that Amby renames or moves, resolved inbound wikilinks are rewritten
to the new vault-relative target. Aliases and heading/block anchors are kept.
Only links resolved by the SQLite index to the moved note are changed, avoiding
unsafe rewrites of ambiguous text. Each changed source note is snapshotted
before the refactor; if a link rewrite fails, already rewritten source notes
are restored to their pre-refactor text.
