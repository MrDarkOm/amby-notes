# Documentation map

Read only the relevant contract/section. Documentation status matters: an old
audit, proposal or handoff does not establish present behavior. Verify against
the [code map](ai/MAP.md), implementation and tests; report contradictions rather
than silently changing source data to match a plan.

| Topic                                                                                                                                                                       | Read when                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Agent guidelines](ai/agent-guidelines.md)                                                                                                                                  | Applicable engineering, formatting, safety or release rules before editing                                                                                                                                    |
| [Agent context design](ai/agent-context.md)                                                                                                                                 | Maintaining instructions/maps or onboarding a different tool                                                                                                                                                  |
| [Engineering](engineering.md)                                                                                                                                               | Quality gates, migration practices, package versions, formula failure contracts                                                                                                                               |
| [Vault format](vault-format.md)                                                                                                                                             | Persistence, IDs, YAML, source ownership, conflict/recovery behavior                                                                                                                                          |
| [Markdown compatibility](markdown-compatibility.md)                                                                                                                         | Parsing, serialization, Live Preview admission and fixtures                                                                                                                                                   |
| [Mutation protocol](mutation-protocol.md)                                                                                                                                   | Multi-file writes, journals, revisions/CAS, recovery outcomes (design)                                                                                                                                        |
| [Filesystem security](filesystem-security.md)                                                                                                                               | Canonical paths, access boundaries, asset scope                                                                                                                                                               |
| [Bundle system](bundle-system.md)                                                                                                                                           | Note bundles, layers, move/rename behavior                                                                                                                                                                    |
| [Themes and localization](themes-and-localization.md)                                                                                                                       | CSS/tokens, portable themes, visible strings                                                                                                                                                                  |
| [Native storage contract](native-storage-contract.md), [native UI smoke](native-ui-smoke.md)                                                                                | Desktop verification and prerequisites                                                                                                                                                                        |
| [Database format](database-format.md), [runtime](database-runtime.md), [frontend](database-frontend.md), [user flows](database-user-flows.md), [system](database-system.md) | Database design and contracts; documents include proposed behavior, so check status and implementation                                                                                                        |
| [Creative format](creative-format.md)                                                                                                                                       | Creative module (`amby.creative`): flat workshop format v3, implemented and checked against the code (v2 only as a diagnostic)                                                                                |
| [Sync plan](sync-plan.md)                                                                                                                                                   | Encrypted sync through a self-hosted server: promises, threat model, decisions Р1–Р14, stages Э0–Э5 (crypto, server, the connect screen and the engine are built; the engine runs in the app for test vaults) |
| [Performance baseline](performance-baseline.md)                                                                                                                             | Performance comparison methodology/evidence                                                                                                                                                                   |
| [Update system](update-system.md), [Windows release checklist](windows-release-checklist.md), [macOS signing and Keychain prompts](dev-signing.md)                          | Packaging, updater and release operations                                                                                                                                                                     |
| [Security advisories](security-advisories.md)                                                                                                                               | Dependency/security findings and recorded verification                                                                                                                                                        |

## Folder layout

- `docs/` holds contracts and audits that describe the present behavior.
- [ai/](ai/MAP.md) holds the agent instructions: the root code map (`ai/MAP.md`, entry point from `AGENTS.md`),
  [agent guidelines](ai/agent-guidelines.md) and [agent context design](ai/agent-context.md).
- [road/](road/) holds everything planned, one file per category: [ai](road/ai.md) (AI panel, provider
  connections, write-capable agent), [mobile](road/mobile.md), [sync](road/sync.md) (gate reports; the plan
  itself is [sync-plan.md](sync-plan.md)), [boards](road/boards.md) (Excalidraw board), [modules](road/modules.md)
  (modules and plugins) and [database](road/database.md). Each file opens with a status table; its parts are
  the former separate plans. Status and counts can reflect an earlier revision; do not bulk-load these files.
- [road/target/](road/target/README.md) lists what was deferred on purpose (sync, AI, editor, safety,
  platforms) and the product [ideas](road/target/IDEAS.md). Read it before proposing "next" work.
- `docs/archive/` is local only and is not in git (ignored): full texts of old plans, audits, handoffs and
  reports kept on the owner's machine. It may be absent in a checkout; never link to it from tracked files.
- [../updates/](../updates/README.md) is public cumulative release data. Keep internal operational steps in
  docs, not in user-facing release notes.

## Plans and evidence, read only for the task

- `*-plan.md`, `*-audit-*.md` and dated platform audits capture proposed work or evidence. Locate them with
  `rg --files docs` when the task names that initiative. A checkbox is not a substitute for verifying code.
- Plans keep a "Status" line at the top (checked 2026-11-03); read it first. [Windows audit](windows-audit-2026-09-28.md),
  [storage audit](storage-issues-audit.md) and the [editor audit](editor-audit-2026-10/) are evidence, not contracts.

When a contract changes, update its owning document and the map only if routing
changes. Keep detailed facts in one owner rather than copying whole contracts.
