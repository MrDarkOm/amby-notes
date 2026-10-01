# Durable data and mutation contract

This contract applies to note bodies, Canvas and Excalidraw documents, custom
properties, database manifests, bundle operations, migrations, and recovery.
`vault-format.md` and `markdown-compatibility.md` define the corresponding
formats. Implementations must preserve the guarantees below; a successful
unit test for a helper does not prove its production caller enforces them.

## Ownership and successful writes

Markdown, attachments, database manifests, and durable property sidecars belong
to the user. SQLite is a derived index and may be rebuilt without rewriting
those sources. A cache failure must remain distinguishable from a failed data
write. Removing a cache is never permission to remove durable sidecars.

A mutation reports success only after its durable writes have completed. It
must distinguish an external revision conflict, a failure before publication,
and an incomplete operation requiring recovery. Errors creating a required
history snapshot or recovery point stop the mutation before replacement.

Writes use the existing atomic replacement or no-replace creation helpers.
Preserve BOMs, line endings, unknown syntax, and bytes outside the intended
change. Property changes target the exact top-level YAML key and must not
alter a same-named nested key or block-scalar content.

## Revisions and editor state

Check the original file revision again at the publication boundary. Watcher
fingerprints of new output bytes suppress self-events; they are not a check of
the original file. A serialized application mutation queue does not exclude
external programs, so history and explicit conflict handling remain necessary.
Path-based checks and a read followed by rename cannot promise perfect
cross-process compare-and-swap against arbitrary filesystem races.

Each completed save belongs to one document revision and vault generation. An
older response must not clear newer dirty state or discard a newer recovery
draft. External change or deletion of an unsaved document must remain visible
as a conflict without silently closing the document.

Live Preview editing is available only when the current source round-trips
byte-for-byte through the actual parser and serializer. Check at entry and
after source replacement, not only in diagnostics. Refusing Live Preview must
not serialize or save the incompatible source as a side effect.

## Multi-file operations and recovery

Before changing any target, perform read-only validation of the complete
operation, record the input revisions, and create durable recovery points.
Journal formats are versioned and old supported versions remain recoverable.
Publish each file atomically and record enough progress to detect already
applied writes after interruption. Update derived caches after durable sources.

Ordinary filesystems do not provide a transaction across independent files.
An operation must therefore finish, roll back safely, or remain explicitly
recoverable. A failed rollback is not a successful rollback. Preserve recovery
data and report the failure. Repeating recovery is idempotent; user edits made
after the operation must not be overwritten by an automatic rollback.

Treat journals as untrusted input. Validate every target and backup path, not
just the location of the journal JSON. Validate the entire plan before the first
write, including migration resume and rollback. A malformed or conflicted
pending operation must not silently disappear during vault activation.

Deletion follows the repository's vault-local, restorable trash contract.
Any separate system-trash action has a distinct contract and must not promise
the internal archive's restore guarantees. Recovery must detect interrupted
trash operations and preserve unclassified payloads instead of deleting them.

## Security boundaries and verification

Rust validates paths and typed inputs independently of frontend checks.
Package identifiers, versions, staging locations, entry paths, and file sets
must be validated before installation, replacement, rollback, or removal.
Installed package metadata is not trusted simply because it is already on disk.

Module publication uses `modules/<id>/pending-publish.json` (format version 1).
The intent contains the staging handle, verified manifest, previous version
metadata (the recovery point), and the intended next metadata. It is written
before moving the staged directory. Publication then writes `versions.json`
atomically and removes the intent. A failed write retains both version files
and the intent; listing, opening, rollback, or another publish reconciles it.
Recovery validates paths, bytes and signatures again and refuses to overwrite
version metadata that matches neither the previous nor the intended state.
The same staging handle can complete an interrupted first install. After
completion, the existing rollback operation selects the retained previous
version. This journal does not yet coordinate the separate frontend registry.

Community code must not be imported into the privileged renderer as a way to
make installation work. A Worker alone is not proof of a security boundary.
Verify the actual runtime under packaged CSP, including attempts to bypass
permission-checked RPC. Do not expand scopes or disable CSP to pass tests.

Use isolated synthetic fixtures and controlled failure injection for write,
snapshot, publication, cache, rollback, and restart boundaries. Test-only
failure switches must not be enabled in production builds. Record unsupported
platform checks as unavailable, not passed.
