# CLI map

`cargo build --locked -p amby-cli` builds `amby` without the desktop runtime.
The [CLI contract](../../docs/cli.md) describes commands, the JSON envelope,
exit codes, vault selection and MCP configuration.

- [args.rs](src/args.rs) parses commands and global options.
- [config.rs](src/config.rs) reads the desktop vault registry and stores the CLI selection separately.
- [main.rs](src/main.rs) resolves note references and formats command results, including `prop`, `delete`, `info`, `orphans`, `unresolved`, `attachments`, `attach`, `bulk` and filtered `search`.
- [The local IPC contract](../../docs/cli-ipc.md) defines delegation to the desktop if the vault lease is held.
- [The shared structural operations](../amby-core/src/structural/mod.rs) implement rename, move, archive, restore and recovery.
- [daily.rs](src/daily.rs) adds the write scope, previews and module switches to the [shared template and daily-note rules](../amby-core/src/note_templates.rs).
- [edit.rs](src/edit.rs) reads payloads and renders previews for [the shared note writer](../amby-core/src/note_edit.rs).
- Tool schemas and the shared read dispatch live in `amby-core` ([tool_set](../amby-core/src/tool_set/mod.rs)); the desktop AI panel uses the same definitions. The CLI files below re-export them and keep the dispatch that needs the CLI (writes, local desktop IPC, `open_in_amby`).
- [mcp_tools.rs](src/mcp_tools.rs) dispatches scoped operations, including property and deletion tools. See the [MCP tools contract](../../docs/mcp.md).
- [mcp_extra.rs](src/mcp_extra.rs) holds the hygiene, attachment, template, daily-note, property order and bulk tools and the prompts.
- [mcp_notes.rs](src/mcp_notes.rs) holds `edit_note`, `restore_version` and `open_in_amby`; the outline, section and version reads are `tool_set::note_read`.
- [mcp.rs](src/mcp.rs) carries the shared JSON-RPC tools over bounded stdio frames, serves notes as resources and reports changes of subscribed notes.
- [launch.rs](src/launch.rs) dispatches a note path to the [desktop argv handler](../../src-tauri/src/cli_open.rs).
- The [read-only core catalog](../amby-core/src/index/read_only.rs) owns snapshot validation and the disk fallback.
- [cli.rs](tests/cli.rs) exercises the binary with disposable vaults; [props_search_delete.rs](tests/props_search_delete.rs) covers properties, filtered search, deletion and the MCP protocol fixes; [links_attachments_bulk.rs](tests/links_attachments_bulk.rs) covers hygiene, attachments, property order, prompts and bulk edits, [daily_templates.rs](tests/daily_templates.rs) covers templates and daily notes, [notes_history.rs](tests/notes_history.rs) covers fragment edits, sections, versions, row deletion and subscriptions, with fixtures in [common](tests/common/mod.rs).
