# Documentation map

Read only the relevant contract/section. Documentation status matters: an old
audit, proposal or handoff does not establish present behavior. Verify against
the [code map](../MAP.md), implementation and tests; report contradictions rather
than silently changing source data to match a plan.

| Topic                                                                                                                                                                       | Read when                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Agent guidelines](agent-guidelines.md)                                                                                                                                     | Applicable engineering, formatting, safety or release rules before editing                                                                                                                                    |
| [Agent context design](agent-context.md)                                                                                                                                    | Maintaining instructions/maps or onboarding a different tool                                                                                                                                                  |
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

## Plans and evidence, read only for the task

- [AI provider connections](Road/ai-provider-connections-plan.md): proposed API/CLI
  connections, model catalogs, settings migration and staged acceptance checks.
- [Road/](Road/) contains execution plans, orchestration, acceptance lists and
  architecture audits. Their file paths/status/counts can reflect an earlier
  revision; do not bulk-load this directory on startup.
- `*-plan.md`, `*-audit-*.md`, `*-handoff.md` and dated platform audits capture
  proposed work or handoff evidence. Locate them with `rg --files docs` when the
  task names that initiative. A checkbox is not a substitute for verifying code.
- [archive/](archive/README.md) is one file: short records of finished plans, audits and
  reports (what was decided, where the contract lives). Full texts are in git history
  (commit `7b838c8`). Open it only for a regression's history or an explicit request.
- Plans keep a "Status" line at the top (checked 2026-11-02); read it first. [Claude handoff](claude-handoff.md),
  [Windows audit](windows-audit-2026-09-28.md), [storage audit](storage-issues-audit.md) and the
  [editor audit](editor-audit-2026-10/) are evidence, not contracts.
- [IDEAS.md](IDEAS.md) is product exploration, not implementation instructions.
- [updates/](../updates/README.md) is public cumulative release data. Keep internal
  operational steps in docs, not in user-facing release notes.

When a contract changes, update its owning document and the map only if routing
changes. Keep detailed facts in one owner rather than copying whole contracts.
