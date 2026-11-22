# AI panel: the full vault tool set with proposals and modes

Status 2026-11-21: agreed with the owner. Stage 1 (one tool set, panel reads) is done. Stage 2 is mostly done for note text: engine (`amby-core/src/ai_proposals/`), write tools `new_note` / `append_note` / `edit_note` that only propose (`ai_tools`), the proposal store and apply / reject / undo commands through the mutation gate (`src-tauri/src/ai/proposals.rs`), cards and the whole-vault scope (the tree switch) in the panel. Cards and the switch live in memory only (the chat file format is unchanged), so a restart expires pending cards and turns the switch off. Property proposals (`set_property`, `delete_property`, `rename_property`) go through the property engine under the mutation gate; its versions are `ai-edit` while a panel apply runs (`history::AiPropertyEdit`), and Undo restores the oldest version of the apply (presentation records in `.amby` stay as dormant ones). A vault that is not in the property-group format refuses them. Not done: a native check of the panel in `tauri dev` by eye. Owner changes 2026-11-21 (after a first look): the edit tools are always offered to a model with tools and refuse what is outside the context (the whole vault is the tree switch: with it on, the AI searches and may propose changes anywhere; there is no separate write switch); the approval mode is a button right of the model picker (hand = Manual, shield = Auto, red shield with ! = Turbo, which asks once). Auto and Turbo already apply text and property proposals at once from the renderer, which knows the unsaved notes (the card keeps Undo and waits while its note has unsaved edits); they differ only once move, rename, archive and delete exist (stage 4). Stage 3 (databases) is done for rows and cells: `create_database_row` and `set_database_value` propose, are offered with the whole vault in view (the IDs come from `list_databases`), carry the row's raw revision from the moment of the proposal, apply through the database domain under the mutation gate with `ai-edit` versions (`database-value` versions are mapped like property ones), and undo restores the row or deletes the created row to the trash. Stage 4 (move, rename, archive, delete) is done in code: `move_item`, `rename_item`, `archive_item`, `delete_item` only propose; the card lists every affected file (children, attachments, notes whose links are rewritten) from the `vault_tools` preview, and the proposal is outdated if any of them changed. A deletion follows the user's deletion setting exactly like a manual delete (the system trash, or the archive; never permanent; `ai_apply_proposal` takes the mode from the renderer): to the system trash it cannot be undone from the card, so the card warns before Apply and offers no Undo afterwards, and a deletion waits for Apply in every mode, Turbo included; with the archive setting it is an archive and Undo restores it. The tool description tells the model to prefer `archive_item` when the user may want the item back. Undo of move/rename is the inverse operation; of archive, restore from the archive. Notes with unsaved edits among the affected files block Apply and Undo. Auto applies no structural change; Turbo applies move, rename and archive at once. Stage 5 (Auto and Turbo) is done as described above. Native check by eye, 2026-11-21 (a bundled test copy with Codex, a throwaway vault): reading, text and property cards, rename with link rewriting, archive, deletion to the system trash, Auto and Turbo, and every Undo work; fixed after it: the open note and the approval mode are named in the context, answer parts around tool steps are separate paragraphs, steps have words, appended list items continue the list; and after a second check, the turn request carries the approval mode so the write tools answer "applied" or "pending" truthfully (`AiTurnRequest.approvalMode`, `ai_tools::Approval`), and a note named without `.md` is resolved in the change itself. Rechecked by eye after the fixes. Native contract test (2026-11-22, `tests/native/ai-contract.ts`, run by `npm run test:storage:live`): through the real Tauri commands and a loopback provider that can call any tool (`Call tool NAME {json}` in `native_contract_ai.rs`) it covers propose → apply → undo for an append, a property change (after `open_vault_properties`), a database cell and a database row, and a rename with link rewriting (Apply and Undo refused while an affected note has unsaved edits, passed as `unsavedPaths`); and `approvalMode` (none/manual/auto/turbo give the tool reply "pending" or "applied" per kind, a deletion is always "pending", and no turn writes by itself). No missing behaviour was found. A row made by Apply reaches the database projection through the `database:changed` rebuild request, as an MCP write does; the contract test rebuilds the projection itself. Not checked by eye: database cards (new row, cell: Apply, Undo) and Apply/Undo waiting on unsaved edits in the real panel. The attempt was stopped because the bundled test copy shares `~/Library/Application Support/Amby` with the owner's app, and pointing it at a throwaway vault means rewriting the owner's `workspaces.json`, which was not authorised; both behaviours stay covered by the native contract test and renderer tests.

## 1. Today

The in-app AI panel (all providers) has four read-only tools: `search_notes`,
`read_note`, `list_folder`, `get_links` (`crates/amby-core/src/ai_tools.rs`). They are
bounded by `ToolBudget` and by `ToolScope`, which comes from the context chips under the
composer and the conversation's search switch; the model never chooses its own authority.
Codex and Claude Code get the same tools through Amby's internal MCP bridge
(`src-tauri/src/ai/turn.rs`, `VaultToolHost`; `src-tauri/src/ai/codex/mcp.rs`,
`src-tauri/src/ai/claude_code.rs`); API providers get them as function calls.

The external `amby mcp` server (`crates/amby-cli/src/mcp*.rs`, contract in
[docs/mcp.md](../mcp.md)) already has much more: fragment edits (`edit_note`), outline and
sections, properties, databases, workshops, versions and restore, structural operations,
deletion to the trash. Its dispatch lives in the CLI crate, so the desktop cannot reuse it.

## 2. Owner decisions (2026-11-21)

- **Where the panel may write:** a per-conversation switch. By default only the notes and
  folders in the context chips (and new notes in those folders); the switch allows the
  whole vault. Reads keep today's rules.
- **Confirmation:** proposal cards plus three per-conversation modes:
  - **Manual** (default): every write is a card in the chat with what changes (a diff;
    for move/rename/archive/delete the full list of affected files) and Apply / Reject.
    Nothing is written without a click.
  - **Auto:** text, property and database-value writes apply at once and the card keeps
    Undo; move, rename, archive and delete still wait for Apply.
  - **Turbo:** everything applies at once, including move and delete (trash only); every
    card keeps Undo. Switching to Turbo shows one short warning.
- **First version writes:** note text (new, append, `edit_note`), properties, databases
  (rows and cell values), move / rename / archive / delete.

## 3. Data-safety rules (all modes)

- Every applied write leaves an `ai-edit` version; Undo on the card is `restore_version`
  (or the inverse move, or restore from trash/archive).
- A note that is open with unsaved edits is never overwritten: the card waits until the
  note is saved. A clean open note is reread as an external edit.
- A proposal is checked against the note's current bytes or revision when applied; if the
  note changed after the model read it, the card says it is outdated and does not apply.
- Writes go through the desktop mutation gate (ordered with editor saves), never as a
  second process. Per-turn limits for writes, as for reads. No permanent deletion.
- Proposals are pending state, not instructions: a tool call returns at once with a
  proposal ID (no waiting for the click inside the provider's tool call, which would time
  out). Apply happens from the card.

## 4. Stages

1. **One tool set** (done 2026-11-21: `amby-core/src/tool_set/` holds every MCP schema and the read dispatch; the panel offers `get_outline`, `read_section`, `get_properties`, `get_note_info`, `list_versions`, `read_version` always, and `list_tags`, `list_databases`, `read_database`, `query_database` with search on; write schemas moved too, write dispatch stays in the CLI until stage 2). Move the MCP tool schemas and dispatch from `crates/amby-cli/src/`
   (`mcp_tools.rs`, `mcp_extra.rs`, `mcp_notes.rs`) into `amby-core` so the CLI server, the
   desktop bridge and API providers share them. The panel gains the read tools: outline and
   sections, properties, tags, databases, note info, versions. CLI and MCP behaviour and
   their tests stay unchanged.
2. **Proposal cards and Manual** for note text and properties; the "whole vault" switch;
   Undo. UI strings in `src/locales/resources.ts`, notices per [docs/notices.md](../notices.md).
3. **Databases:** rows and cell values, with revisions.
4. **Move, rename, archive, delete** with the affected-files list.
5. **Auto and Turbo.**

Each stage: tests first (contract tests for the shared tools, UI tests for cards and
modes), `npm run rust:test`, strict Clippy, `npm run verify`, native check of the panel
in `npm run tauri dev`, an entry in `updates/upd_next.md`.

Text attachments (2026-11-21): the paperclip attaches text files to the next message only; their text goes into that turn's system context as data (`buildAttachedContext`), the chat keeps their names, and nothing is stored. Images and other binary files are not supported.
