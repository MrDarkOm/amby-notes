# Project map

Choose one route; read additional maps only when the task crosses their boundary.
This is an ownership index of the working code, not a feature-completion claim.

| Task / symptom                                                 | Start here                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------------- |
| Startup, app shell, shared UI                                  | [Frontend](src/MAP.md)                                     |
| Tabs, sidebar, tree, folder cards, workspace state             | [Workspace](src/components/workspace/MAP.md)               |
| Document surface, Source/Live Preview switch, title, export    | [Editor](src/components/workspace/editor/MAP.md)           |
| Markdown parser, serializer, blocks, columns, wiki links       | [Tiptap](src/components/workspace/tiptap/MAP.md)           |
| Autosave, dirty state, recovery, external-edit conflicts       | [Save lifecycle](src/components/workspace/autosave/MAP.md) |
| Database views, cells, query state, note peek                  | [Database UI](src/components/workspace/database/MAP.md)    |
| Database files, formula, projection, mutations                 | [Database backend](src-tauri/src/database/MAP.md)          |
| Creative workshop panel, pages, dossier, plot                  | [Creative](src/components/workspace/creative/MAP.md)       |
| Creative workshop files, creation, recovery (`amby-workshop`)  | [Workshop backend](src-tauri/src/project/MAP.md)           |
| Canvas nodes, edges, layout, undo                              | [Canvas](src/components/workspace/canvas/MAP.md)           |
| Excalidraw scenes, embedded notes                              | [Sketch](src/components/workspace/sketch/MAP.md)           |
| IPC, storage contracts, web fallback                           | [Storage](src/lib/storage/MAP.md)                          |
| Module lifecycle, capabilities, profiles, package installation | [Modules](src/lib/modules/MAP.md)                          |
| AI client, updater, diagnostics, recovery helpers              | [Shared services](src/lib/MAP.md)                          |
| Themes, CSS, icons, localization                               | [Appearance](src/themes/MAP.md)                            |
| Vault I/O, IDs, indexing, links, bundles, history, trash       | [Rust services](src-tauri/src/MAP.md)                      |
| Desktop bootstrap, permissions, packaging                      | [Tauri](src-tauri/MAP.md)                                  |
| Commands, CI, benchmarks, release automation                   | [Tooling](scripts/MAP.md)                                  |
| Encrypted sync: crypto, server, conformance, client (`sync/`)  | [Sync](sync/MAP.md)                                        |
| Sync connect screen: settings section, wizard, recovery code   | [Sync UI](src/components/workspace/sync/MAP.md)            |
| Test selection, fixtures, native verification                  | [Tests](tests/MAP.md)                                      |
| Product contracts versus proposals and historical audits       | [Documentation](docs/MAP.md)                               |
| Public release notes                                           | [Updates](updates/README.md)                               |

## Trace a change across layers

- Note edits: editor → document store / autosave → storage repositories →
  `commands/notes.rs` → frontmatter/atomic write → index/watch events.
- Filesystem actions: tree/file-actions → storage mutations →
  `commands/mutations.rs` → bundle/vault/trash services → tree reconciliation.
- Database edits: database controller → storage database port →
  `commands/database.rs` → durable database mutation → rebuildable projection.
- Creative workshop: panel / page → `project-port.ts` → `commands/project.rs` → journaled
  operation (`project/`) → structure file and databases → index/watch (`project:changed`).
- Optional features: module definition → module host registries/capabilities →
  feature UI → storage boundary. A roadmap does not prove a feature exists.

Use scoped searches, for example `rg -n 'writeNote' src/lib/storage src-tauri/src/commands`
or `rg --files src/components/workspace/tiptap`. Read facade targets before adding
logic: `storage.ts`, `workspace.tsx`, `document-editor.tsx` and `vault_index.rs`
mostly route to the actual owners.

For maintaining this navigation or adapting another agent, see
[context design](docs/agent-context.md). For mandatory engineering/release rules,
read the applicable section of [guidelines](docs/agent-guidelines.md).
