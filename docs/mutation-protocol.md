# Durable mutation protocol (design, S3.1)

Status: **design reviewed with S3.2 partly implemented** (2 Oct 2026). Section 6
lists what exists; section 8 marks what is done and what remains.
Companion contracts: [data safety](data-safety-contract.md),
[vault format](vault-format.md), [native storage](native-storage-contract.md).

## 1. Goal and non-goals

Give every operation that changes more than one user-owned file, or whose cache
update can fail after the file write, one honest guarantee:

> The operation is **fully applied**, **safely rolled back**, or **detected and
> recoverable after a crash** with the evidence preserved.

Non-goals: a distributed transaction framework, atomicity across files on a
plain filesystem, or a replacement for the domain journals. Several files do not
become one atomic write; a cross-process race between a read and a rename is
narrowed by compare-before-publish and detected, not eliminated.

## 2. Outcomes

One vocabulary for every mutating command. Existing types already cover part of
it (`IndexState`, `OperationWarning`, `WriteNoteError::RevisionConflict`).

| Outcome             | Meaning                                                                   | User data                       |
| ------------------- | ------------------------------------------------------------------------- | ------------------------------- |
| `saved`             | All targets published, cache current                                      | new                             |
| `saved` + warning   | Targets published, cache needs rebuild (`IndexState::RebuildRequired`)    | new; **never reported as loss** |
| `conflict`          | A target changed since the caller's `expectedRevision`; nothing written   | unchanged                       |
| `rejected`          | Preflight failed (validation, path, dependency); nothing written          | unchanged                       |
| `recovery-required` | Crash or failed rollback left a journal; user action or activation needed | recoverable, journal retained   |

`recovery-required` is an explicit error type with the operation ID, never a
silent success. A failed rollback is not a rollback (data-safety contract).

## 3. Revisions

- A revision token is the SHA-256 of the **raw bytes** of the file (`raw_revision`).
  It must cover the whole file including YAML, BOM and line endings, so an
  external frontmatter edit changes it.
- Every write of existing user data takes `expectedRevision` and compares it to
  the current bytes immediately before publishing. A mismatch returns
  `conflict` with the actual revision. There is no weaker path for the same data.
- Multi-file operations keep one `expectedRevision` per target.

## 4. Operation shape

```text
1. preflight   read-only: validate request, canonical paths, revisions, dependencies
2. journal     create_new (no-replace) journal with operationId, allowed targets,
               original fingerprints, backup refs; sync file and directory
3. backup      immutable raw backups of every target before any destructive step
4. prepare     compute all new bytes in memory / staged files
5. re-check    compare every target to its journalled fingerprint again
6. publish     atomic replace per file; mark each step `applied` in the journal
7. cache       update SQLite/derived state; failure => `RebuildRequired` warning
8. complete    mark journal `completed`; keep or prune per retention
```

Rules:

- Steps 2–4 finish before the first destructive change. A snapshot or journal
  failure blocks the write.
- A journal holds **data only**: operation ID (`[A-Za-z0-9_-]{1,160}`), relative
  paths under the vault, revisions, step status. Never executable instructions or
  unvalidated absolute paths. Unknown fields are preserved (`extra`).
- Journals are untrusted input. Validate the **whole plan** (every target and
  backup path, symlinks, reserved directories, extension, duplicates) before the
  first restore write. Version, preflight, backup, idempotent recovery, outcome
  and rollback apply to any persistent schema change.
- Recovery recognises already-published steps. If a target changed after the
  operation started (fingerprint equals neither original nor target), recovery
  reports a conflict and keeps the journal; it never overwrites the user's edit.

## 5. Locks and ordering

Rule to adopt, fixed order and never reversed: `mutation_gate` → `conn` (SQLite) →
per-journal file (audit existing callers when implementing S3.2). Long preflight reads happen outside `conn`. The existing `write_note`
already follows this (prepare outside, publish under `mutation_gate`, index after).
Concurrent operations on one document are serialized by the caller's queue keyed
by file; a finished old operation must not clear newer dirty state.

## 6. What already exists (reuse, do not rebuild)

| Primitive                                                   | Where                                                      |
| ----------------------------------------------------------- | ---------------------------------------------------------- |
| `atomic_write_bytes`, `atomic_write_bytes_new`              | `frontmatter.rs`                                           |
| operation ID / revision validation, `guarded_path`          | `database/relation_recovery.rs`                            |
| journal read with revision, CAS write (`check_revision`)    | `database/relation_recovery.rs`                            |
| preflight **all** pending journals before the first restore | `prepare_pending_relations` / `restore_prepared_relations` |
| reciprocal-schema journal (v1 create, v2 configure/convert) | `database/relation_schema_recovery.rs`                     |
| batch recovery                                              | `database/mutations.rs` (`recover_pending_batches`)        |
| ID-migration journals with path checks                      | `vault/migration.rs`                                       |
| module publish journal                                      | `package_manager.rs` (`pending-publish.json`)              |
| note CAS + `IndexState` outcome                             | `commands/notes.rs` (`write_note`), `model.rs`             |

## 7. Gaps this design must close

1. ~~`write_file` has no expected revision~~ — **done for Canvas/Excalidraw**:
   `write_file` takes an optional `expectedRevision` (SHA-256 of raw bytes),
   compares under `mutation_gate`, returns the new revision and a typed
   `revisionConflict`. The renderer keeps a per-path baseline captured before
   each read (`FileRevisionTracker`); a conflict pauses autosave, keeps the
   recovery draft and tells the user. Still open: no conflict-resolution UI for
   these files (only a notice), renamed paths fall back to the current revision,
   and the unconditional form remains for explicit conflict resolution.

2. Helpers (path guard, id validation, `create_new`, directory sync, journal CAS)
   live inside the database module, so other journals re-implement them. (S3.2)
3. Activation swallows recovery errors:
   `let _ = recover_pending_batches(..)` and `let _ = sweep_expired_recovery(..)`
   in `vault_context.rs`. A pending batch that fails to recover is invisible. (S3.2/S5.1)
4. No shared outcome type: `recovery-required` is not representable for
   non-Relation operations. (S3.2)
5. No failure-injection matrix on real boundaries. (S3.3)

## 8. Plan

**Progress.** Done in S3.2: `durable.rs` holds the shared validators and path
primitives (Relation value and schema journals and batch recovery use it);
`recover_pending_batches` now attempts every journal and moves one that is
unreadable or cannot be rolled back (for example a note edited after the crash)
into `quarantine/` with its backups; it is logged and never blocks the vault.
The stricter Relation journals still block activation. Not done: the generic `JournalFile` type, the
`recovery-required` outcome for non-Relation commands, per-database (rather than
whole-vault) blocking, and all of S3.3.

**S3.2 — extract, do not invent.** New crate-level module (`durable.rs`) with:
`valid_operation_id`, `valid_revision`, `guarded_vault_path`, `create_new_synced`,
a generic `JournalFile` (read-with-revision, CAS write, status transitions) and
`preflight_all`. Move `relation_recovery.rs` onto it **with unchanged behavior**;
its 13 recovery tests (plus 14 in `relation_schema_recovery_test.rs`) are the regression gate. Add the `recovery-required` error
and stop swallowing activation errors (surface them as an activation warning
that blocks only the affected database, not the whole vault).

**S3.3 — failure matrix** (done for the two-way Relation value update: every
`atomic_write_bytes` call, failing before or right after publication, then
activation recovery; 22 boundaries; test-only hook in `frontmatter.rs`. A
real process-kill test re-runs the operation in a child test process that
`abort()`s at 12 chosen writes, then recovers in the parent), only real boundaries: read failure, snapshot, temp
write, sync, first publish, second publish, cache update, completion record,
rollback. Fault switches are `cfg(test)` only. Two controlled-subprocess
interruption tests (kill between publish steps, restart, recover). Windows
filesystem guarantees are documented separately; no Unix fsync semantics are
promised there.

**Done when:** the design is reviewed, the shared module has tests, Relation
journals run on it unchanged, and activation no longer hides recovery failures.
S4 then applies the protocol to saves (S4.1), sidecar/relations (S4.2) and
bundle/rename/link refactor (S4.3).

## 9. Open decisions

- Should `saved + RebuildRequired` get its own visible UI state, or stay a toast?
  (Recommendation: keep the existing warning; surface in S5.1.)
- Journal retention: keep `completed` journals N days for diagnostics or prune
  immediately? (Recommendation: prune after the next successful activation.)
