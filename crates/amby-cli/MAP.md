# CLI map

`cargo build --locked -p amby-cli` builds `amby` without the desktop runtime.
The [CLI contract](../../docs/cli.md) describes commands, the JSON envelope,
exit codes, vault selection and MCP configuration.

- [args.rs](src/args.rs) parses commands and global options.
- [config.rs](src/config.rs) reads the desktop vault registry and stores the CLI selection separately.
- [main.rs](src/main.rs) resolves note references and formats command results, including `prop`, `delete`, `info`, `orphans`, `unresolved`, `attachments`, `attach`, `bulk` and filtered `search`.
- [The local IPC contract](../../docs/cli-ipc.md) defines delegation to the desktop if the vault lease is held.
- [The shared structural operations](../amby-core/src/structural/mod.rs) implement rename, move, archive, restore and recovery.
- [edit.rs](src/edit.rs) reads payloads and renders previews for [the shared note writer](../amby-core/src/note_edit.rs).
- [mcp_tools.rs](src/mcp_tools.rs) describes the tool schemas and dispatches scoped operations, including property and deletion tools. See the [MCP tools contract](../../docs/mcp.md).
- [mcp_extra.rs](src/mcp_extra.rs) holds the hygiene, attachment, property order and bulk tools and the prompts.
- [mcp.rs](src/mcp.rs) carries the shared JSON-RPC tools over bounded stdio frames and serves notes as resources.
- [launch.rs](src/launch.rs) dispatches a note path to the [desktop argv handler](../../src-tauri/src/cli_open.rs).
- The [read-only core catalog](../amby-core/src/index/read_only.rs) owns snapshot validation and the disk fallback.
- [cli.rs](tests/cli.rs) exercises the binary with disposable vaults; [props_search_delete.rs](tests/props_search_delete.rs) covers properties, filtered search, deletion and the MCP protocol fixes; [links_attachments_bulk.rs](tests/links_attachments_bulk.rs) covers hygiene, attachments, property order, prompts and bulk edits, with fixtures in [common](tests/common/mod.rs).
