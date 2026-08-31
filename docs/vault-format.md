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

## Frontmatter `amby-id`

Amby's service identifier is the top-level YAML field `amby-id`. It is a
canonical uppercase ULID, for example `01ARZ3NDEKTSV4RRFFQ69G5FAV`, stable across
rename and move. The generic `id` field belongs to the user, including numbers,
nulls, external strings such as `jira-123`, and collections. New assignments
never replace or remove it. An explicit `amby-id` always takes precedence;
an invalid value produces a diagnostic and never falls back to generic `id`.

For compatibility, a canonical ULID in `id` with no `amby-id` is a legacy
identity candidate. Normal indexing and body-only saves keep that file's
frontmatter unchanged. A ULID alone cannot prove Amby ownership: migration is
separately confirmed with a read-only file preview, raw backups, journal, and
rollback. It adds `amby-id` with the same value and leaves the entire generic
`id` property untouched. Duplicate candidates are reported, not migrated.
Stable IDs and all durable sidecar keys remain unchanged in this migration.

Both notes with a duplicate ID remain visible in the tree and searchable.
The existing primary path (or first deterministic path on a rebuild) retains
the stable index ID; other duplicates get a rebuildable path-scoped conflict
key. Invalid namespaced IDs and YAML forms that cannot accept ID insertion
also get conflict keys where their body can be parsed. No conflict key is
written into Markdown. Conflicts are re-read on refresh, including the primary
member of a duplicate group. Body saves, deleted-note restoration, and durable
custom-property mutations are refused until the identity is unique again.
The editor and properties panel show a localized read-only warning. Malformed
YAML uses the separate body-editing policy below; it is not an ID conflict.

The index's `identity_version = 2` marker invalidates the metadata skip path
once so older cached interpretations are re-read. SQLite is still disposable;
rebuilding it neither migrates legacy IDs nor deletes durable property data.

### Malformed frontmatter

Frontmatter status is `none`, `valid`, `invalid`, or `unterminated`. A closed
envelope with a YAML parse error or a non-mapping root (including a scalar,
sequence, or explicit null) still exposes the Markdown body. The index keeps its
path, filename/title fallback, body-derived title, tags, wiki links, word count,
and search text. YAML-derived properties/tags are unavailable, and the properties
panel displays a localized diagnostic rather than hiding the note.

Invalid YAML cannot establish a trusted stable ID. The index uses disposable
`amby-opaque:body:<relative-path>` keys, re-read on every scan, without inserting
or changing an ID in the source. These keys never identify durable custom
properties. Body saves validate the key against the current path and envelope,
preserve the complete YAML envelope byte-for-byte (including BOM and mixed line
endings), and apply the existing line-ending convention only to the body. Saves
snapshot the original bytes before an atomic publication. Opaque-note revisions
hash the full source, so even a YAML-only external change conflicts with an older
save. Property mutations are blocked in the backend as well as the UI.

An opening `---` line with no closing fence is `unterminated`: there is no safe
boundary between YAML and Markdown. Amby indexes the complete source to keep it
discoverable, uses `amby-opaque:source:<relative-path>`, and forces the editor to
Source mode. The user can explicitly edit that full source, with normal BOM and
dominant line-ending preservation; Amby never inserts a delimiter or repairs YAML
automatically. Once repaired, save, refresh the vault, and reopen the note. A
stale opaque key cannot save after its source becomes valid or its boundary
changes. Refresh replaces it with the recovered/new stable identity.

Opaque keys are path-scoped, not stable across moves or cache rebuilds after
repair. Move indexing derives a key for the new path without rewriting YAML.
Deleted-note restoration validates the path against the retained source template
and uses the no-replace writer. Link refactors preserve invalid closed envelopes
and replace references only in the body; unterminated sources are excluded from
automatic link replacement because their YAML boundary is unknown. Invalid YAML
is never a reason to discard the source, apply a frontmatter migration, or hide
its text from the tree/search.

Recoverable YAML warnings acknowledge completed watcher events. Filesystem or
UTF-8 read failures abort the scan before index changes, keeping the previous
cache and pending events available for retry instead of treating unreadable notes
as deleted.

### Lossless ID insertion

When an ID is assigned, Amby inserts one line immediately after the opening
frontmatter fence without serializing the existing YAML. The original BOM,
comments, quotes, anchors, whitespace, fence bytes, and body remain unchanged,
including mixed line endings. The inserted line uses the opening fence's line
ending. If there is no envelope, Amby creates one using the body's first line
ending (LF for an empty or single-line body), keeping any BOM at byte zero.

Empty and comment-only envelopes accept their first property. Every existing
`amby-id` value, including null, numbers, and collections, is protected from
replacement. Generic `id` values are preserved as ordinary YAML properties. Malformed or unterminated frontmatter, scalar/sequence roots, and
representations that cannot accept the splice safely (such as root flow maps)
return an error identifying the file; Amby does not reformat them to make the
insertion succeed. It validates the resulting YAML against the original
mapping plus the new ID before writing any bytes.

ID assignment uses the atomic raw-byte writer, with the existing history
snapshot or migration backup. The body editor's dominant-line-ending conversion
does not run for this metadata-only operation.

### ID migration recovery

An ID migration creates its versioned journal in `.amby/migrations/` before it
creates a backup or changes a note. The journal contains the complete planned
file list, a generated or retained legacy ID for each file, a vault-relative backup root, and
durable per-file progress (`pending`, `backupCreated`, `applied`, or
`rolledBack`). Journal writes are atomic and sync both the journal and its
parent directory.

For every planned note Amby publishes a no-replace raw-byte backup first,
records that backup, atomically writes the ID, and then records that the note
was applied. A journal is marked `completed` only after every file is applied.
On the next vault-open attempt an incomplete (`planned` or `inProgress`)
journal is surfaced before indexing; the user may resume it, roll it back, or
inspect it without opening the vault. Resume recognises a note that already
matches the exact planned output when a crash occurred between the note write
and the journal update. Rollback restores raw backup bytes only when the
current bytes equal the original or the exact migration result; an unchanged
ID alone is insufficient. Later body or frontmatter edits stop recovery rather
than being overwritten. Both resume and rollback are idempotent.

New journals use version 2. Version-1 journals remain recoverable: the old
serialized and lossless generic-ID outputs are reconstructed only for
read-only comparison with the backup. Already-applied v1 notes remain as-is
on resume; pending writes use `amby-id`. No new write uses generic `id`.
Rollback of a completed migration uses the same journal and restores its raw
backups, provided subsequent edits have not changed the files. Do not delete
backups or journals until recovery is no longer needed, and do not downgrade
to an older Amby build against newly created namespaced-only notes: older
builds do not understand this identity format.

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

The rebuildable SQLite index stores `mtime_ns` as Unix nanoseconds at the
filesystem's available precision. The existing `mtime`/IPC `modified` values
remain Unix seconds for display. Unknown or unrepresentable precise timestamps
are stored as NULL and never qualify for a metadata cache hit. A cold scan can
skip a note only when its precise timestamp and size match; this assumes those
metadata changed when the contents changed while Amby was not watching.

Watcher events invalidate the affected paths before notifying any renderer,
even when the precise timestamp and size are identical. Folder events include
descendants; OS rescan flags, missing event paths, and watcher errors request a
full content scan. Access-only events are ignored. Exact self-write fingerprints
still suppress Amby's own events, but do not suppress external text with equal
size/time. Content is re-read directly for invalidated files; no additional
persistent hash algorithm or cryptographic hash is needed for this decision.
Events arriving during a refresh remain queued, and failed refreshes retain
their invalidations for retry. Queues belong to one vault activation. Renderers
also re-read open descendants on folder/root events, applying the usual dirty
buffer conflict rules.

Cache stamp format version 2 is recorded as `index_metadata.file_stamp_version`.
Initialization inspects the schema before adding the nullable `mtime_ns` column;
the column and outcome marker commit in one SQLite transaction. Existing rows
start with NULL and are re-read once. A failed upgrade rolls back to the prior
cache schema/rows; retry is safe. Markdown, IDs, and durable property sidecars are
not migrated. For rollback/recovery, close Amby and remove only the rebuildable
`.amby/notes.db` database and its `-wal`/`-shm` companions, then reopen to rebuild
from Markdown and durable sidecars. Do not remove the `.amby/` directory.

Changes from outside Amby are coalesced during short filesystem bursts and then
re-indexed. Clean open documents reload automatically. If an open document has
unsaved edits, autosave is paused and Amby presents both versions: the user can
accept the external text, explicitly save the local text, or create a manual
merge buffer. A uniquely named sibling copy (`Name.<random-id>-conflict.md`)
can preserve the local text before
accepting an external version. An externally deleted open document is never closed silently; its
local version can be restored by an explicit save.

Deletion is classified after the coalesced tree refresh by the stable note ID,
not only by the platform-specific raw watcher event (`remove` versus `rename`).
While a Markdown buffer is open, Amby retains its last complete source as an
in-memory restore template. Explicit restoration validates the active vault and
stable ID, publishes with the atomic no-replace path, preserves opaque
frontmatter, UTF-8 BOM, and the dominant line-ending convention, then rebuilds
the SQLite cache entry. If the path reappears before publication, restoration
fails instead of overwriting the new file.

## Local history

Before Amby replaces an existing note or text file, it stores the original raw
bytes in `.amby/history/`. Snapshots preserve BOM and line endings exactly and
include the original byte count plus an integrity hash; a damaged version is
never restored silently. A versioned `.amby/history/manifest.json` is the
authoritative snapshot metadata index, so opening one note's history does not
scan every metadata JSON file. Older per-snapshot JSON metadata is imported once
when the manifest is first needed; it may remain on disk as harmless legacy
metadata.

Normal `note-save` and `file-save` autosaves create at most one pre-write
history snapshot per source file in a rolling ten-minute interval. This
coalesces versions only: the Markdown/text file is still saved after the normal
short editor debounce, recovery drafts remain durable, and no existing history
entry is deleted. ID assignment, link refactor, restore, and other explicitly
forced snapshots keep their recovery points regardless of the autosave interval;
rename and move retain their existing rollback/recovery contracts.

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
the on-disk version, Amby prompts the user to restore the recovered text. Tabs
restored from the previous session use the same recovery-aware load path as an
explicitly opened note, and native recovery prompts are serialized. Accepting a
draft marks the buffer dirty and immediately queues a versioned filesystem save;
the draft remains until that save succeeds. Declining loads the disk version and
deletes only that document's draft. A vault-generation change while a prompt is
open abandons the stale decision without changing either the new vault or the
old draft.

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
