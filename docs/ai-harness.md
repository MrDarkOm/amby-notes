# Amby AI Agent Contract

Status: draft specification, no implementation. Document version: 1. Date: 2026-09-30.

This is a detailed elaboration of the plan, not a description of an already working
system. The names of new actions, fields, and states are a proposed public
contract. H-00 checks it against the future baseline, H-01 pins down
the schemas and fixtures. The existence of this documentation does not close H-00/H-01 or G0.

Related documents: [action catalog](ai-action-catalog.md),
[state format](ai-state-format.md),
implementation packages,
acceptance,
[data safety](data-safety-contract.md),
[files](vault-format.md), [Markdown](markdown-compatibility.md).

## 1. What the harness is

The harness is the execution environment around the model: a catalog of capabilities, collection of the permitted
context, execution of operations, permissions, a journal, result verification, recovery,
memory, and skills. The model proposes a sequence of actions. The application
checks and executes each of them, then returns the actual result.

The agent understands the application through four sources:

1. Versioned descriptions of entities, formats, and the relations between them.
2. A catalog of the commands that are actually available, with the limits of the current module.
3. The state of the permitted part of the space, obtained through the read/query API.
4. The results of its own actions and verified skills for solving tasks.

Reading the application's entire source code on every request is not required. The API
documentation ships with the application; API changes update the catalog version and the skill
compatibility checks. Access to arbitrary internal functions is not provided.

### 1.1 Owners of responsibility

| Component                   | Responsibility                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| UI and existing stores      | User request, choice of scope, dirty buffers, preview, history, and conflict resolution          |
| Runtime in Rust             | Jobs, budgets, provider transport, sequence of model/tool calls, stopping, and checkpoints       |
| Registry and policy in Rust | Schemas, module availability, actor action, permissions for all affected resources               |
| Executor in Rust            | Preconditions, serialization, journal intent, invocation of the shared domain operation, receipt |
| Domain services             | Lossless changes to notes, databases, boards, settings; identical rules for the UI and the agent |
| Journal/recovery            | Durable history, before/after evidence, re-recognition of the result, undo                       |
| Skill/learning services     | Selection of pinned versions, lesson proposals, trials, version management                       |
| Plugin host                 | Code isolation and SDK; every data access goes through a verified broker                         |

Legacy UI IPC may exist during the transition, but it is not available to the model or an
untrusted plugin as a way around the executor. The privilege of a call is determined by the
host session/channel, not by the `actor` field from JSON. H-70 checks for bypasses through raw
Tauri invoke, the asset protocol, Worker globals, and direct network access.

## 2. User modes

| Mode    | Space data                                    | Changes                                                                 |
| ------- | --------------------------------------------- | ----------------------------------------------------------------------- |
| Discuss | Only the provided context and permitted reads | Forbidden; the host records the journal and the conversation checkpoint |
| Prepare | Reads for composing an exact plan             | Service preview; notes, settings, and active plugins are not changed    |
| Execute | Per the issued grant                          | Permitted actions with a journal and the provided undo                  |

The user chooses the scope and the mode once per job. Ordinary operations
within that permission do not require re-confirmation at every step.
An additional choice is needed when the scope is expanded, on a new external effect,
on a change of plugin permissions, or when a conflict is detected. The model may propose
an expansion, but cannot press the confirmation or issue itself a grant.

`Prepare` saves a description of the operations, values, references, and revisions. For the combination
"create a note → add it to a board", typed references to the
result of the preceding step are used; the host reserves the IDs. Deterministic defaults
are fixed before the preview. If a step's result requires a new creative decision
by the model, that is the next version of the plan, not an unnoticed part of the one already confirmed.

Permission for an exact plan is tied to the plan digest, the source revisions,
the effects, the grant revision, and the expiry period. A material change to any of
them makes the confirmation stale. The direct execution mode
uses the current grant; a preview is not required for every step.

## 3. Entities and identifiers

| Entity                  | Identifier and purpose                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| Workspace               | Opaque `workspaceId` from the host registry; the canonical root and binding revision are stored separately |
| Grant                   | `grantId` + monotonic revision; immutable history of user decisions                                        |
| Submission              | `submissionId` issued by the host; a transport retry repeats it, a new request gets a new one              |
| Run                     | `runId`; one workspace or only global settings                                                             |
| Step                    | `stepId`; a logical step of the plan, may have several attempts                                            |
| Operation               | `operationId`; the single intent to apply specific arguments to specific resources                         |
| Attempt                 | `attemptId`; a transport/execution retry of the same operation without a new intent                        |
| Resource                | Type + namespace + stable object ID/verified locator; a path string by itself is not authority             |
| Receipt                 | `receiptId`; the verified result of an operation with revisions and outcome                                |
| Skill/proposal/artifact | Stable ID + immutable content digest; a new edition gets a new revision                                    |

The provider tool-call ID must not be used as the only operation ID:
a provider may repeat a response with a new ID. The runtime stores the mapping of a tool call to a
specific step/operation. A repetition of a semantically similar action by the model is
additionally detected by a loop detector; this is not proof of idempotency.

## 4. The Action contract

### 4.1 Descriptor

| Field                           | Requirement                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `actionId`, `schemaVersion`     | Stable name and schema version; an unknown version is not executed                 |
| `capabilityVersion`, `moduleId` | The real version of the domain adapter and the availability condition              |
| `inputSchema`, `outputSchema`   | Closed types, limits on size/depth; unknown arguments are rejected                 |
| `effectKind`                    | `read`, `durableMutation`, `transient`, `external`; mixed effects are enumerated   |
| `resourceResolver`              | The host determines the read/write/effect closure, including side changes          |
| `preconditions`                 | Revisions, expected absence, schema/module generation, editor checkpoint           |
| `preview`, `verify`             | A verifiable preview and postconditions; not arbitrary model text                  |
| `undoClass`                     | `snapshot`, `fieldPatch`, `inverseDomain`, `none`, `manualExternal`                |
| `limits`                        | Input/response size, number of objects, expiry period, cost, and permitted retries |

The descriptor does not contain an arbitrary handler from a skill. A plugin declares
a catalog extension through the SDK, but the host binds it to the plugin's sandbox and permissions;
it does not become a privileged core command.

### 4.2 Request

The runtime adds to the validated arguments `runId`, `stepId`, `operationId`,
`attemptId`, `grantId/revision`, `workspaceBindingRevision`, `generation`,
`catalogVersion`, expected revisions, and an approved plan reference, if required.
These fields cannot be overridden by the model.

The operation digest includes the action/schema version, the normalized typed
arguments, references to input blobs, preconditions, and the workspace and grant revision.
Normalization does not change meaningful content bytes, line endings, the order of
lists, or numbers. The canonical representation algorithm is versioned in H-01.
The same operation ID with a different digest returns `idempotencyConflict`.

### 4.3 Receipt

A receipt contains the actual created IDs, resource references, before/after
revisions, time, the domain journal reference, verification results, the undo manifest
reference, cache/index status, and safe diagnostic codes.

| `outcome`             | Meaning                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `succeeded`           | Durable postconditions verified; the cache state is separately `ready`/`pending`/`failed` |
| `noChange`            | Preconditions matched, no changes were needed; no new data versions were created          |
| `rejected`            | Policy/schema/preconditions stopped the action before publication                         |
| `failedBeforePublish` | Operational error, the absence of published effects is confirmed                          |
| `partial`             | The applied and unapplied parts are known; there is a recovery plan                       |
| `outcomeUnknown`      | It cannot be proven which effects occurred; retry is forbidden until reconciliation       |

An updated React state or a model's "done" text does not count as a receipt.
A SQLite error after a successful write does not trigger a retry of the write to the source file.
A run does not report a completed user-facing result until the postconditions it needs
are verified. Pending indexing is indicated separately.

### 4.4 Errors and the next action

| Code                                         | Runtime reaction                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| `permissionDenied`, `scopeChanged`           | Stop dependent steps; obtain a user decision or shrink the plan                |
| `moduleUnavailable`, `unsupportedCapability` | Refresh the catalog; do not substitute the action with a raw write             |
| `validationFailed`                           | Safe diagnostics; limited correction of arguments                              |
| `revisionConflict`, `dirtyBufferConflict`    | A new preview or user resolution of the conflict                               |
| `journalUnavailable`, `quotaExceeded`        | Suspend the agent's access to new effects/data until the journal is recovered  |
| `idempotencyConflict`                        | Runtime/protocol error; automatic replacement of the operation ID is forbidden |
| `outcomeUnknown`                             | Move to recovery; do not repeat the operation blindly                          |
| `cancelled`                                  | Do not start the following actions; reconcile any publication already begun    |

## 5. Grant and scope of access

A grant binds a trusted user decision to the following constraints:

- workspace identity, binding revision, current generation;
- separate read/write roots and object capabilities;
- an allowlist of actions and settings keys, indicating global/workspace;
- access to the journal, skill/memory namespaces, and specific plugin projects;
- provider profile, permitted categories of data sent;
- expiry period, budgets, approval rules, job mode.

### 5.1 Scope checks

Policy is invoked before a read, before revealing a result, before every
provider request, and immediately before publication. Work is also checked
on resume, replay of UI events, undo, and plugin callback. A UI filter does not replace
a backend check. The cache key includes the scope revision and the resource revision.

In the first contract, write access to an existing object requires read access:
preview, verification, and undo must see its original state. The capability to
create a new object is set on the parent, includes an absence check, and
does not allow reading neighboring files. Scope membership is determined by canonical
identity; after a rename/move the path is checked again.

Search filters objects before snippets, ranking, totals, pagination, and aggregation.
Relation/rollup/transclusion, the full-text index, and embedding retrieval are subject to
the same scope. An unknown or inaccessible object gets the same external
response `notAccessible`; the diagnostic log is not revealed to an agent without rights.

### 5.2 Logical permissions and physical files

The user permits changing a note's property, while the backend may update
the shared `.amby/properties.json`. Permission for a note gives the domain adapter the right to
change its section of the sidecar surgically; reading/writing neighboring entries by the agent is
forbidden. The full file participates in the internal CAS/backup but is not given to the model.
Undo of such an action applies the inverse to the permitted fields and preserves
subsequent changes to neighboring entries.

Similarly, a settings patch changes a specific key and does not give access to the entire
`settings.json`. The right to change a database row does not allow changing the database
schema/manifest. Changing a shared schema requires a separate capability on the whole schema.
Physical lock sets may be wider than the logical grant; a domain adapter does not
use this as a right to other semantic changes.

### 5.3 The full set of effects

Rename, move, database type change, bundle deletion, and refactor compute the
closure before writing: sources, destinations, attachments, related metadata, and
the references being changed. If the closure goes beyond the grant, the operation does not start.
The response does not show the names of inaccessible objects. The host UI may ask the user for a
broader scope without passing its content to the model in advance.

A read note, a web page, error text, a skill, or a generated plugin
cannot set new permissions. Tool results are marked as data.
Long excerpts from notes are not inserted into the system instruction.

## 6. Execution and editor coordination

### 6.1 Mutation sequence

1. Check the schema, grant, module, limits; compute the effect closure.
2. Obtain editor barriers without holding filesystem/settings locks.
3. Complete the coordinated autosaves; a dirty conflict requires a user decision.
4. Take locks in a stable order, re-check the scope/revisions/barriers.
5. Save snapshots, the inverse manifest, and a durable prepared intent.
6. Apply the shared domain operation with atomic publication of individual files.
7. Re-read the durable state, record the receipt and verification.
8. Release locks/barriers, update stores/index, and deliver UI events.

Clean buffers are reconciled automatically. In the dirty state the safe default
is a pause with a choice of "save my edits and recompute", "show the
diff", or "skip the action". Discarding edits is not implied.
If the user chose in advance to autosave before the agent,
it uses the ordinary coordinator and is explicitly reflected in the timeline.

The snapshot for undoing an agent step is taken after the user's edits are saved.
Undo returns exactly that state. Unsaved recovery drafts
are not replaced by the agent's snapshot and are not deleted on its successful response.

### 6.2 Barrier between windows

The host knows the registered windows and the documents they have open. A lease contains
the window/session ID, document identity, vault generation, and checkpoint. A barrier
confirmation from one window does not cover the others. During a short publication
the editor blocks writes to the corresponding document and cancels stale saves;
new user input is not lost and is not published on top of the result.

The closing/hanging of a window or the expiry of a lease is not treated as consent to lose a
buffer. First the recovery drafts and the window state are reconciled. Inability to
prove safe coordination yields `dirtyBufferConflict`/`needsRecovery`.
When a document is fully closed, the domain action works without mounting the UI.

### 6.3 Locks and the limits of guarantees

The order of all domain locks: global settings/module namespace, workspace ID,
canonical resource key. A shared lock covers a file even if two actions
change different logical keys. The existing mutation gate in Rust is included in this
hierarchy; the transition does not create an independent queue that bypasses the old one.

Blocking on journal append is short-lived; the recovery reader does not hold it while waiting for a
domain lock. Waiting for the user/model and obtaining an editor barrier never
happen under a write lock. Several Amby processes must use
confirmed inter-process coordination or reject the second writer.

External programs are not obliged to honor Amby's locks. Re-checking revisions
at publication reduces the risk of a race but does not promise filesystem compare-and-swap
against an arbitrary external writer. History and explicit conflicts are mandatory.

## 7. Runtime and context

The main run states: `queued`, `running`, `waitingForUser`, `pausedConflict`,
`needsRecovery`, `succeeded`, `failed`, `cancelled`. Undo has a separate state.
After a restart, restored unfinished jobs wait for the user to continue them;
replay does not start new model calls automatically.

Every provider request records the profile/model, capability versions, context
references, budgets, and the request ID. Credentials are available only to the transport. A tool call
is executed after the complete JSON is received and validated; streaming fragments do not
trigger partial mutations. Several tool calls in one response are not permission to
execute dependent writes in parallel.

A context item has a source, resource revision, scope provenance, visibility,
range/chunk, and a truncation flag. A summary of the dialogue preserves the user's requirements,
open questions, operation/receipt references, pending conflicts,
and the boundaries of permissions. The summary itself is not a source of rights or proof of
success. The sources and their revisions are re-checked at the next action.

When a grant narrows, the runtime stops requests and rebuilds the context without
forbidden sources, including summaries, memory, and screenshots. Data already sent
to the provider cannot be recalled by this mechanism; the UI does not promise their deletion.
An old provider conversation/cache handle is not reused. Fallback to another
provider is permitted only by the user's current rule about data transfer.

The budget defaults from the plan are starting product limits, not a benchmark.
Model calls, tokens, tools, active time, retries, and learning are counted separately.
Provider usage `unknown` is not equal to zero; when the cost is unknown, the limits on
calls/tokens/time remain hard. Retrying the same error is limited; waiting for the user
does not consume the active-time limit, but the grant may expire.

## 8. Undo, stopping, and external effects

Undo is launched as a new operation with the current permissions, the inverse manifest, and
a check of the after revisions. Task undo is a graph of reverse dependencies, not just
reverse time order. A new user link or row that depends on
a created object blocks the dangerous deletion of that object.

A file snapshot requires the post-operation bytes to match. For a field patch,
the presence/value of the changed keys, the schema version, and semantic
dependencies are checked; neighboring keys are preserved. An inconsistent set of fields is not
rolled back in parts under the guise of full success. A repeated undo is recognized by ID.

Reverting individual steps without the rest is permitted only after the dependency
closure is checked. The UI shows `available`, `conflict`, `partial`, `unavailable` and the reason.
Redo is a new execution of the original intent with a new preview/preconditions,
not a repetition of the old model message or a blind publication of the after snapshot.

In the current baseline `deleteItem` uses the system trash, and `archiveItem` uses
`.amby/trash/`. The ordinary autonomous set includes `item.archive` with a verifiable
restore. `item.systemTrash` has `manualExternal` and by default
`requiresUserInteraction`; it must not be passed off as a guaranteed reversible
agent operation. A request specifically for the system trash is not replaced by archiving.
Permanent purge of history/archive is not part of an ordinary grant.

Deleting objects created by the agent during undo also uses the internal archive
with a restore manifest. Archiving a layer must have its own domain
operation: the current `deleteLayer` cannot be renamed into a safe archive adapter.

Stop forbids the following steps. If atomic publication has already begun, the runtime
first classifies its result and records a receipt. Stop does not mean undo.
Revoking a grant forbids new substantive writes, including compensation; the host
may finish the audit and read-only reconciliation of the operation that has begun. Applying
recovery to data after revocation requires the user's current permission.

## 9. Skills, memory, and learning

### 9.1 Skill contract

| Revision field                       | Meaning                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------- |
| ID, revision digest, parent digest   | Immutable version and lineage                                             |
| title, description, trigger examples | When the skill is useful; not a global instruction                        |
| owner, origin, namespace             | User, built-in, or agent-owned; the area of origin                        |
| required actions/schema versions     | Compatibility check against the current catalog                           |
| applicability/preconditions          | When the procedure applies and when to decline                            |
| procedure/resources                  | Text procedure, examples, scoped references; executable assets separately |
| expected outcomes/verification       | Result checks; the acceptance criteria are controlled by the host         |
| evidence/evaluation refs             | The jobs the lesson was derived from and the trial reports                |
| status                               | `draft`, `proposed`, `verified`, `active`, `disabled`, `archived`         |

During search, brief cards of the permitted skills are available first; the full
content is loaded as needed. A job pins a specific digest.
Activating a new version does not change a job that is already running. A security revoke
may stop it regardless of pinning.

A skill describes a way of working but does not issue a grant and does not increase the budget.
A "how to run the script" section in an imported SKILL file does not make the script
executable. Executable extensions go through the plugin lifecycle and sandbox.
A user/pinned skill is not rewritten automatically.

### 9.2 Learning cycle

1. After a job completes, collect scoped evidence: the outcome, user corrections,
   recurring errors, cost, and verified receipts.
2. Decide whether there is a transferable lesson; the absence of a useful lesson is a normal outcome.
3. Create a proposal: the target base revision, a text diff, the reason, provenance,
   the required capabilities, test tasks, and risks.
4. Check the format, scope, secrets, conflict with the source skill, and the owner's rights.
5. Run baseline/candidate on fresh isolated fixtures; the holdout and
   criteria are not available to the candidate for modification. Do not replay real actions.
6. Save a report linking the exact digests of the candidate, corpus, harness, and
   model configuration. The result does not carry over to changed bytes.
7. In `propose` mode, show the diff and the evidence to the user. In an explicitly
   enabled `autoVerified`, activate only an agent-owned text-only version
   without new authority, external effects, and scope expansion.
8. Record an activation event and a previous active reference for rollback.

If the base skill changed after the trial, the proposal becomes `stale`; a new
revision requires re-verification. A negative result of a real job
creates evidence/a proposal but does not give the model the right to silently rewrite its own policy.
Quality is assessed by successful outcomes and regressions, not by how often
a skill is chosen. The curator archives versions while preserving references; it does not delete pinned,
user-owned, or data in use by unfinished jobs.

### 9.3 Memory

A user preference, a fact about a project, a procedure, and an audit event are separate
data types. A memory record contains source references/revisions, namespace,
time, freshness period, and confirmation status. A model inference is marked as
an inference, not as a user rule. An explicit user correction
supersedes the earlier fact while preserving history; an unchanged summary does not revive
deleted memory.

A lesson from a private section inherits its restrictions even after names are removed.
Moving it to the global library requires a separate preview and a user decision
on publication/generalization. The scope of learning is no wider than the intersection of the current grant and
the provenance of the sources. After a source is revoked, dependent summaries/embeddings
are not given to the model until a safe rebuild.

## 10. Plugin workshop

A user request "make a plugin" creates a plugin project with a separate
namespace. The cycle: description → project files → verification → build → isolated
preview → version/permissions diff → activation → observation → next revision.

Authoring permissions are limited to the files of the given project. The build runner uses
fixed dependencies and host commands; arbitrary shell commands,
package lifecycle scripts, and network install are forbidden. An unsupported dependency
returns diagnostics. Creating an arbitrary native Rust/Node extension is not part of
the first version of the workshop.

Preview gets a synthetic workspace and a separate profile; access to a real
section is enabled by a separate user grant. The permissions of plugin code are equal to
the intersection of the manifest permissions, the install permissions, the current workspace, and
the calling agent grant. A background plugin task has its own principal/grant;
it does not inherit a completed run without explicit permission.

Activation is tied to the digest of the sources, dependency lock, compiler configuration,
artifact, and permission diff. A change to any input resets the verification
results. Local origin is not marked with an official Amby signature.
Runtime isolation must be proven in a production build; a Worker without a DOM is
insufficient. If a safe runtime is not ready, authoring remains available
for preparing a project, while live activation is blocked.

The installer keeps the previous version and reconciles the backend publication journal
with the frontend registry. Their current separate state cannot be considered a shared
transaction. Code rollback and user data rollback differ:
a plugin migration has its own versioned preflight/backup/recovery contract.
Deleting a plugin does not delete its user data without a separate decision.

## 11. End-to-end example

Request: "In the project section, create a note with a plan, a task database with a table and
a board, a sketch in Excalidraw with links to the notes; turn on a large font".

1. The grant covers the project section, its database/board objects, and the specific
   global key `prefs.fontSize`. The user sees that the font will change globally.
2. The agent reads the available catalog. If the requested database layout does not exist yet,
   it reports the limitation; it does not save an unknown discriminant.
3. The preview fixes the database schema, properties, two views, texts, and scene elements;
   the links use the results of creating the objects, not guessed IDs.
4. Notes, database/views, Excalidraw, and the setting are executed as dependent steps with
   shared domain adapters. Each step has its own receipt.
5. The checks re-read the data, run a scoped database query, and verify the scene's
   links; a visual preview is used only from permitted sources.
6. If the Excalidraw step failed, the UI shows the created objects and the rest of the plan.
   The user chooses to continue, keep, or roll back; "all done" is not claimed.
7. Task undo restores the setting by key and cancels the dependent objects.
   If the user added a task to the new database, its deletion is suspended.

## 12. Decisions to verify before implementation

| Decision/uncertainty                                         | Owner and evidence                                                    |
| ------------------------------------------------------------ | --------------------------------------------------------------------- |
| The exact IPC/schema representation of these fields          | H-01; schemas, fixtures, generated bindings at implementation         |
| Hierarchy of existing mutexes and inter-process coordination | H-11/H-22; native concurrency/failure tests                           |
| Atomic replace/fsync and system trash per platform           | H-21/H-40; crash matrix and capability statuses                       |
| Layouts/templates/linked views of the actual database        | H-00/H-41; source inventory and UI parity                             |
| Shared commands of the new board and codec limitations       | H-42/H-43 together with the Excalidraw plan; lossless/native evidence |
| Real isolation of the plugin runtime and compiler            | H-70/H-71; adversarial packaged tests                                 |
| Specific provider/model configurations                       | H-30; protocol fixtures and separate live probes                      |

For comparative research on skills, see the primary sources in
the borrowings section of the plan.
Architectural ideas are not permission to copy code without checking the version
and license. Automatic learning changes versions of procedures/memory; training
of model weights is not part of this contract.
