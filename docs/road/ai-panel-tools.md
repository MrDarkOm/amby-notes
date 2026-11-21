# AI panel: the full vault tool set with proposals and modes

Status 2026-11-21: agreed with the owner. Stage 1 (one tool set, panel reads) is done. Stage 2 is mostly done for note text: engine (`amby-core/src/ai_proposals/`), write tools `new_note` / `append_note` / `edit_note` that only propose (`ai_tools`), the proposal store and apply / reject / undo commands through the mutation gate (`src-tauri/src/ai/proposals.rs`), cards and the whole-vault scope (the tree switch) in the panel. Cards and the switch live in memory only (the chat file format is unchanged), so a restart expires pending cards and turns the switch off. Property proposals (`set_property`, `delete_property`, `rename_property`) go through the property engine under the mutation gate; its versions are `ai-edit` while a panel apply runs (`history::AiPropertyEdit`), and Undo restores the oldest version of the apply (presentation records in `.amby` stay as dormant ones). A vault that is not in the property-group format refuses them. Not done: a native check of the panel in `tauri dev` by eye. Owner changes 2026-11-21 (after a first look): the edit tools are always offered to a model with tools and refuse what is outside the context (the whole vault is the tree switch: with it on, the AI searches and may propose changes anywhere; there is no separate write switch); the approval mode is a button right of the model picker (hand = Manual, shield = Auto, red shield with ! = Turbo, which asks once). Auto and Turbo already apply text and property proposals at once from the renderer, which knows the unsaved notes (the card keeps Undo and waits while its note has unsaved edits); they differ only once move, rename, archive and delete exist (stage 4). Stages 3 and 4 are not started.

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
