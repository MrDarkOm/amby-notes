# Audit of saving, file format, and persistence issues in Amby Notes

> **Status as of 2026-11-02:** partly outdated. The database migration section (R1 and others) has been withdrawn: the database migration module was removed (commit `3efd792`, the `.ambd/records/` shard format is no longer supported). The remaining items have not been re-checked.

**Date written:** 2026-09-23  
**Status:** Current audit of the persistence and data-safety architecture  
**Audit scope:** File write mechanisms, autosave, databases (Frontmatter-First), the module architecture (0.1.5), external sync, and local history.

---

## 1. Introduction and audit goals

Amby Notes is positioned as a safe **Local-First** knowledge management application in which the user's Markdown files and attachments are the absolute source of truth, and any derived structures (the SQLite index) remain rebuildable.

Despite a solid foundation (atomic writes via sibling temporary files, strict UTF-8, overwrite protection on creation via hard link, CAS revisions of notes), a deep analysis of the codebase, together with the latest independent audits, revealed a set of architectural problems, data-loss risks, and performance bottlenecks.

This document consolidates all identified defects and risks so that fixing them can be prioritized.

---

## 2. Critical data-safety problems in databases (P1 / P2)

The database stabilization audit ([`docs/audit/database-stabilization.md`](database-stabilization.md)) recorded open defects:

### 2.1. Migration rollback wipes the user's fresh edits (Defect R1, P1)

- **Files:** [`src-tauri/src/database/migration.rs`](../../src-tauri/src/database/migration.rs#L287), [`src-tauri/src/database/migration.rs`](../../src-tauri/src/database/migration.rs#L555), [`src-tauri/src/database/migration.rs`](../../src-tauri/src/database/migration.rs#L706)
- **The problem:** If a note already contained valid property values in its frontmatter, the migrator still copies it into the backup, but does not actually change the note body. If, after the migration finishes, the user opens the note and adds text, and then a rollback (`Rollback`) is triggered for any reason, the rollback procedure restores the file from the backup and **irrevocably overwrites the added text**.
- **Cause:** `post_migration_hashes` is computed only for files from `planned_writes`. The rollback procedure treats a missing hash in the map as unconditional permission to overwrite. In addition, the hashes are recorded on disk only after the changes are made.
- **Required fix:** Plan the full set of resources with expected revisions before writing begins; exclude files untouched by the migration from being overwritten on rollback; save a durable log before any files are modified.

### 2.2. No crash recovery for batch mutations (Defect R2, P1)

- **Files:** [`src-tauri/src/database/mutations.rs`](../../src-tauri/src/database/mutations.rs#L1625), [`src-tauri/src/database/mutations.rs`](../../src-tauri/src/database/mutations.rs#L1693)
- **The problem:** When several database cells/rows are edited in a batch ([`apply_database_value_batch`](../../src-tauri/src/commands/database.rs)), the original bytes for the compensating rollback are held **only in RAM** (`Vec<u8>`).
- **Cause:** There is no durable on-disk log before the write begins.
- **Consequences:** If the process crashes mid-write (for example, on the 10th note out of 20), the OS terminates abnormally, or power is lost, the database is left torn and partially updated. There is no crash recovery mechanism or idempotent retry of the operation after a restart.

### 2.3. Select option history is kept in process memory (Defect R4, P1)

- **Files:** [`src-tauri/src/database/format.rs`](../../src-tauri/src/database/format.rs#L10), [`src-tauri/src/database/format.rs`](../../src-tauri/src/database/format.rs#L467), [`src-tauri/src/database/format.rs`](../../src-tauri/src/database/format.rs#L919)
- **The problem:** To keep the ULIDs of select-list options stable across renames, the structure `OPTION_NAME_HISTORY: HashMap<String, String>` is used. It is stored exclusively in process memory, with no scoping by database or by specific property.
- **Consequences:**
  1. When the application restarts, the map is cleared. A subsequent read of a previously renamed option loses its link to the ULID and degrades to a plain string.
  2. When identical option names exist in different properties, their stable IDs conflict and overwrite each other.
- **Required fix:** Store durable option aliases directly in the durable property schema manifest (`<Database_Name>.json`).

### 2.4. Unsafe deletion of unknown files during migration (Defect R7, P1/P2)

- **Files:** [`src-tauri/src/database/migration.rs`](../../src-tauri/src/database/migration.rs#L545), [`src-tauri/src/database/migration.rs`](../../src-tauri/src/database/migration.rs#L615)
- **The problem:** When cleaning up obsolete `.ambd/records/` directories, an unconditional `remove_dir_all` is called. The migrator's preflight checks and backs up only the known top-level JSON manifests.
- **Consequences:** Any third-party or unknown files that happen to end up inside the shard folder (for example, binary files or backups from external utilities) are deleted without warning and are not included in the backup.

### 2.5. Broken formula evaluation graph and hidden cycles (Defect R6, P2)

- **Files:** [`src-tauri/src/database/formula.rs`](../../src-tauri/src/database/formula.rs#L775), [`src-tauri/src/database/formula.rs`](../../src-tauri/src/database/formula.rs#L837)
- **The problem:** The dependency graph is built by ID, but dependencies from formula expressions are resolved by column names. The evaluation order is tied to the order of properties in the schema array rather than to a topological sort of the graph.
- **Consequences:** Moving a formula column to the left of its operands makes it impossible to compute the final value; cyclic dependencies by name are swallowed without returning an explicit error.

---

## 3. Risks of the module architecture and space isolation (0.1.5)

The audit of the module system ([`docs/road/modules.md`](../road/modules.md)) revealed architectural inconsistencies:

### 3.1. Vault path leak when switching spaces

- **Files:** `src/lib/modules/host/module-host.ts`, `src/components/workspace/use-presets.ts`
- **The problem:** The `ModuleHost.syncWithWorkspace` method compares only the array of active module IDs. If a module (for example, Canvas, Databases, or a third-party plugin) is enabled in both space `A` and space `B`, it is neither deactivated nor recreated.
- **Consequences:** The `ExtensionApi` instance and the module's internal handlers keep holding the path of space `A`. When saving data, the module may write files into the previous vault.

### 3.2. In-memory module version rollback

- **Files:** `src/lib/modules/package-manager/installer.ts`
- **The problem:** The package version log for the rollback procedure (`moduleVersionHistory`) is kept only in RAM.
- **Consequences:** After the application restarts, rolling back to the previous stable version of a module is impossible because the version history is lost.

---

## 4. Conflicts with external programs and cloud sync

Amby vaults are often placed in cloud-sync folders (iCloud Drive, Syncthing, Dropbox, OneDrive, Git). In these conditions, the following vulnerabilities appear:

### 4.1. Autosave blocked by an external conflict (Silent Data Stagnation)

- **Files:** [`src/components/workspace/file-actions/use-markdown-autosave.ts`](../../src/components/workspace/file-actions/use-markdown-autosave.ts#L66-L69), [`src/components/workspace/external-conflict-dialog.tsx`](../../src/components/workspace/external-conflict-dialog.tsx)
- **The problem:** If an external program (or a cloud synchronizer) updated the file on disk while a document with unsaved edits is open in Amby, the autosave coordinator puts the document into a paused state (`autosave.pause()`), throwing `AutosaveConflictPausedError`.
- **Consequences:** If the user did not notice the conflict dialog that popped up or dismissed it without choosing an action, **autosave for that document stops completely**. For all the following hours of work, the text is saved only in RAM and in the emergency drafts in `.amby/recovery/`, and never reaches the disk.

### 4.2. File locking errors on Windows (`Sharing Violation`)

- **Files:** [`src-tauri/src/frontmatter.rs`](../../src-tauri/src/frontmatter.rs#L939)
- **The problem:** The atomic write renames the temporary file via `fs::rename(&tmp, path)`. On Windows, if a third-party process (an antivirus, the OneDrive agent, the Windows search indexer) holds an open handle on the target file, the `rename` system call fails with `Access is denied` (code 5) or `Sharing violation` (code 32).
- **Consequences:** The write fails, and the code has no retry mechanism with exponential backoff.

### 4.3. False conflicts from the watcher fingerprint timeout (8 seconds)

- **Files:** [`src-tauri/src/watcher.rs`](../../src-tauri/src/watcher.rs#L12)
- **The problem:** Suppression of file system events caused by the application's own writes is based on fingerprints with a time-to-live of `SELF_WRITE_RECORD_TTL = Duration::from_secs(8)`.
- **Consequences:** On slow network drives (SMB/NFS) or with an overloaded iCloud, a file system event may arrive more than 8 seconds late. In that case Amby does not recognize its own write and treats it as an external change, provoking false conflicts.

---

## 5. Autosave and emergency draft problems (Frontend)

### 5.1. Risk of exhausting the `localStorage` quota in Web/Dev mode

- **Files:** [`src/lib/recovery-drafts.ts`](../../src/lib/recovery-drafts.ts#L91-L104)
- **The problem:** In the browser (when developing via `npm run dev`), emergency recovery drafts and the virtual file system are stored in `localStorage`.
- **Consequences:** When working with large notes or several tabs, the 5 MB limit is quickly exhausted, with an uncaught `QuotaExceededError`.

### 5.2. Leftover drafts accumulate when files are moved externally

- **Files:** [`src/lib/recovery-drafts.ts`](../../src/lib/recovery-drafts.ts#L280-L310), [`src-tauri/src/recovery.rs`](../../src-tauri/src/recovery.rs)
- **The problem:** A draft is cleared only on a successful `onSaveSuccess` event. If the user closes a tab that has an error, or the file is renamed/deleted by an external program at the moment of failure, the draft in `.amby/recovery/` stays on disk until the TTL expires (14 days). Every subsequent time a file with the same path is opened, the system persistently offers to restore the stale draft.

---

## 6. Performance, scalability, and disk resources

### 6.1. Global serialization of all write operations (`db.mutation_gate`)

- **Files:** [`src-tauri/src/commands/notes.rs`](../../src-tauri/src/commands/notes.rs#L35), [`src-tauri/src/commands/notes.rs`](../../src-tauri/src/commands/notes.rs#L129), [`src-tauri/src/vault_context.rs`](../../src-tauri/src/vault_context.rs)
- **The problem:** All mutations (saving notes with `write_note`, regular files with `write_file`, creating conflict copies, renaming) acquire a single mutex, `db.mutation_gate`.
- **Consequences:** Inside the lock, data preparation, writing the history snapshot to disk, the atomic write of the temporary file, `sync_all()`, `rename()`, and the synchronous update of the SQLite index are all performed. Any disk I/O delay blocks absolutely all background autosaves of other open documents.

### 6.2. Uncontrolled growth of the local history directory (`.amby/history/`)

- **Files:** [`src-tauri/src/history.rs`](../../src-tauri/src/history.rs#L15), [`src-tauri/src/history.rs`](../../src-tauri/src/history.rs#L417)
- **The problem:** The local version history is a strictly append-only structure. Automatic cleanup by age or vault size is disabled on purpose.
- **Consequences:** On active vaults with hundreds of notes, regular autosaves (up to 1 snapshot per 10 minutes) lead to the `.amby/history/` directory silently growing to tens of gigabytes. The only way to clean it up is a manual confirmation in the UI (keeping the 20 most recent versions), which most users do not know about.

### 6.3. Synchronous markup parsing on every note save

- **Files:** [`src-tauri/src/commands/notes.rs`](../../src-tauri/src/commands/notes.rs#L180-L189), [`src-tauri/src/index/note_index.rs`](../../src-tauri/src/index/note_index.rs#L380)
- **The problem:** Every time the autosave debounce fires, the note-saving thread makes a full pass over the text to extract wiki links (`extract_links`) and tags, after which a synchronous SQLite transaction is opened. For notes of several thousand lines, this creates CPU load spikes and delays in the autosave cycle.

---

## 7. Priority action plan (Action Items)

| Priority | Category    | Task                                                                                                                               |
| :------- | :---------- | :--------------------------------------------------------------------------------------------------------------------------------- |
| **P1**   | Databases   | Fix R1: exclude unchanged files from being overwritten during a database migration Rollback.                                       |
| **P1**   | Databases   | Implement R2: introduce an on-disk durable log for batch operations (`apply_database_value_batch`).                                |
| **P1**   | Databases   | Implement R4: move the storage of Select option aliases into the database manifest schema instead of `OPTION_NAME_HISTORY` in RAM. |
| **P1**   | Modules     | Fix the `ModuleHostContext` reset on vault switch to prevent writing into another vault.                                           |
| **P2**   | Autosave    | Add an indicator and a reminder about blocked autosave when an external conflict exists.                                           |
| **P2**   | Windows I/O | Add a retry policy for `fs::rename` on Windows on file locking errors (`Sharing violation`).                                       |
| **P2**   | Databases   | Fix R6: implement a topological sort of the formula graph by stable IDs.                                                           |
| **P3**   | Performance | Offload `db.mutation_gate`: move the SQLite index update into an asynchronous background queue after the disk write completes.     |
| **P3**   | Disk        | Add optional automatic rotation of old history snapshots (for example, older than 30 days) with a warning to the user.             |
