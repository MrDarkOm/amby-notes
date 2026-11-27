# Amby 0.1.9 — November 27, 2026

Amby 0.1.9 brings Note pages, a major Creative workshop overhaul, AI panel editing with proposal cards and Undo, optional Bundles (formerly Supernotes), Templates and Daily notes, and the bundled `amby` CLI and local MCP server.

## ✨ Highlights

- **Note pages.** First-level headings (`#`) can open as pill tabs in Live Preview and Read mode, with remembered tabs, drag reordering, moving selected blocks to a new page, per-page Find, and quick jump (`Cmd+Option+G` / `Ctrl+Alt+G`).
- **Creative workshop overhaul.** Story desks gain a Chapters board, daily word goals and streaks, a Scene block on text pages, inline character/location name cards, automatic “Found by name” mentions with one-click Bind, dossier tabs, and undoable folder/database import.
- **The AI panel can edit, with your approval.** It proposes new notes, added or replaced text, property changes, database rows and cells, moves, renames, archiving and deletions as cards. Apply each one yourself, or choose Auto or Turbo, and undo any applied change from its card.
- **Bundles as a module, plus Templates and Daily notes.** Supernotes are now called Bundles and can be switched off per vault in Settings → Modules without rewriting files; Templates and Daily notes live in Settings → Modules too.
- **Undo instead of questions, plus CLI and MCP.** Link-updating renames, moves and merges happen at once with exact «Restore», and the bundled CLI and local MCP server connect to Claude Code, Codex, Cursor or Antigravity from Settings.

> **Important.** Amby requires macOS 13 Ventura or newer. Vaults that use the earlier database format may show a migration prompt. Amby makes a backup before migrating.

> **License.** Amby 0.1.9 is distributed under GNU AGPL-3.0. Versions through 0.1.8 remain under MIT.

> **Sync backups.** New pre-sync copies live in Amby's app data and expire 14 days after the first successful sync. Existing copies beside the vault remain available. Restoring from Settings creates a separate folder. Subscription management and deleting the server copy require sync server 0.2.0.

## 🪶 Creative workshop

### Story desks, chapters and goals

- Story cards and search results open the story desk, where you can read and edit the description, customize widget layouts per story or for every story, and open the workshop folder in the file tree or file manager.
- The desk's Chapters widget switches between **List** and **Board**: each part is a column and each page a card showing its first paragraph, point of view and story time, with drag-and-drop reordering that explains refused moves.
- Set a daily word goal under a story's progress on its desk to track today's words and your streak on this device.
- See and change a text page's level from its creation flow or menu, add an Arc level to any story, and bind an existing anchor or create one directly from a text page; the page plot folds cleanly and remembers its state per vault.

### Scenes, names and mentions

- Story text pages include a **Scene** block (point of view, characters, places and story time) whose properties are added only on first use. A character's “Appears in” lists each chapter once in reading order with its story time and a point-of-view mark.
- Character and location names are underlined with a quiet dotted line in story text: hover to preview the entity card, or Cmd-click / Ctrl-click to open its dossier without modifying the file.
- A dossier's “Appears in” also surfaces unlinked story pages under “Found by name” (matching full names, multi-word parts, and `aliases`, including common Russian endings) with passage previews and one-click **Bind**.

### Dossiers, reference and import

- All reference dossiers (including arcs, anchors and custom sections) can open their sections as tabs or as “Whole note”, showing a portrait or image you can set, change or remove right from the header, key fields edited in place, filled-section count, story chips and writing prompts on empty preset headings.
- Edit a section's dossier template from the dossier header (**Section template**): configure sections in order, hints for empty tabs, and which fields appear on each tab or in the header. Use **Add missing sections** to bring older dossiers up to date in Live Preview or Source with full undo.
- Characters, locations and storylines live under Reference, standalone stories stay separate, universe pages mark shared entries, galleries place the dashed add card after existing entries on the same grid, and Create groups actions by type with explicit labels.
- Link notes from folders and Amby databases in one previewed, undoable import with field mapping. Sections open as tables, deleted story links can be cleaned up where they appear, and workshops stay connected when their folder is renamed.
- With Creative and Databases enabled, MCP clients can browse and edit workshops, sections and manuscript pages, and workshop recovery preserves existing data on rollback.

## ✏️ Editor

- **Note pages:** turn first-level headings (`#`) into pill tabs in Live Preview and Read mode via Settings → Editor → Note pages or per-note “Pages in this note” (stored in `amby-pages`, hidden from Properties). Notes reopen on the last tab, support drag reordering, copying page links, moving selected blocks to a new page, per-page Find, quick jump (`Cmd+Option+G` / `Ctrl+Alt+G`), and deleting a page with an option to move its text to a neighbour.
- Live mode preserves untouched Markdown, frontmatter, and line endings. Fixes cover pasted table content, manual line breaks, unknown canvas cards, sketches created by other apps, and removing the last property without leaving a blank header line.
- History follows an identified note across renames and moves, including changes received through sync. Safety snapshots remain available after automatic cleanup.
- Canvases, sketches, and recovery drafts follow their files when renamed or moved. Open notes and editors refresh across windows while preserving unsaved changes for conflict resolution.
- Renaming or moving keeps the style of links: a link by name stays a name when that name is unique.

## 🤖 AI panel

- The AI proposes changes as cards that show exactly what will change and every file a move, rename, archive or deletion touches. Nothing is written until you apply it; Undo restores the previous text, properties, rows or place. A note with unsaved edits waits until it is saved.
- Approval modes: Manual (you apply every card), Auto (text, property and database changes apply at once with Undo) and Turbo (moves, renames and archiving apply at once too). Deletions always wait for you and follow your deletion setting.
- The AI reads notes by section, sees properties, note info, earlier versions, tags and databases, and can find a note by its title. A database you add to the conversation can be read and changed without turning on vault search.
- Attach a text file, a note or a folder from the paperclip menu. Steps name what was read or prepared, answers keep their paragraphs, and the AI knows which note is open now.
- The AI panel saves conversations and supports search, archive and provider settings. Built-in Codex and Claude Code connections ask for consent before sending a conversation or reading vault content.

## 🗃 Databases and Bundles

- Supernotes are now called **Bundles** in English (Мультизаметки in Russian) with a dedicated icon and a toggle in Settings → Modules: with it off, folder conversion and layer management are hidden, a bundle's files show as a folder, and the command line, MCP and AI panel treat its text file as a single file.
- The sidebar can add a text layer to a database, and removing one keeps the rest of the bundle. Open notes show a newly attached database at once.
- MCP clients can inspect schemas and rows, create databases and records, edit properties, and preview reciprocal relation changes. A folder grant must cover every record the operation will write.
- Database views refresh after sync applies a complete batch. Table rendering and cell edits are faster, and stale record revisions are rejected. The folder view labels databases and sketches correctly.

## 🗂 Interface

- Templates: create a note from a template, and make a new template from the template dialog. Daily notes, off by default, open today's note from the dock.
- Settings: the font size and the tooltip delay are smooth sliders, AI agents are a row of tiles with their status, App data uses ordinary rows, and an About section shows the version and licenses. Every section has the same margins.
- Dock menus have the same order everywhere with distinct icons for section and action buttons, and slide-out side panels are one floating sheet. Below 960 px, opening one side panel closes the other.
- Note chrome polish: the layer switch sits directly on the header with an accent line under the active layer, nested-note buttons are more compact with a subtle divider above section tabs, and the file tree shows the bundle icon on Markdown bundles without nested notes (including those with an attached canvas or sketch).
- Open notes, graphs, databases, canvases, and sketches in resizable workspace panes. Tabs remember their scroll position, and the start screen lists recent vaults.
- Unified search covers notes, folders, databases, canvases, text, and tags. The graph saves its layout and zoom when locked and supports back and forward navigation.
- The file tree supports dragging files and folders from the system file manager, offers sorting and filtering in its empty-area menu, and refreshes when an empty folder is deleted.
- Bookmark folders in Favorites, or turn a folder into a note with children. The Attachments panel shows and searches local files, and drops from Finder work in notes and in the file tree.
- Notifications appear next to the dock bell. A notification about a change sync made by itself, such as merged edits, offers «Restore». A properties backup is noted in the notifications too.

## ☁️ Sync

- Browse and restore server versions and deleted files alongside local history. Property styling conflicts can be resolved per note.
- A file over 30 MB, a symbolic link or a service path stays on this computer and is not shown as a problem. A conflict whose two versions became identical closes by itself.
- Sync handles large uploads and folder renames in smaller batches. You can change the account password from Settings, and deleting the server copy of a vault requires the current password.
- Sync protects local edits that arrive during downloads and refreshes the archive after each pass. Backups are easier to read and delete one at a time.

## 🛠 Fixes

- In-app updates download signed packages and install them after all open editors save their changes.
- Renaming and moving notes updates links in visible notes and the archive. Archive and trash operations validate their targets, including when a note shares the vault folder's name.
- Existing identifiers from other apps are preserved. An unreadable Markdown file can be isolated while the rest of the vault opens.
- Local attachments render on Windows, and IME confirmation stays within text entry. Closing and reopening a window and quitting from the macOS Dock now follow the regular save flow.
- "A property was not saved" now appears once, in the note's notice and in the bell, instead of also under the Properties panel. Close it from either place; the next successful property change clears it too.
- Module installation checks signatures and package versions. The previous signing key is revoked, so packages signed with it need to be re-signed with the replacement key.

## For developers

- The CLI and MCP share vault services and the tool set in the Tauri-free `amby-core` crate, including the engine for AI proposals and exact undo. See `docs/cli.md`, `docs/mcp.md`, `docs/ai-harness.md` and `docs/sync-format.md`.
- `ensure_plot_links` accepts optional `parts` (`characters`, `pov`, `places`, `storyTime`) for story scene links (`docs/creative-format.md` §6), and `get_dossier_template` / `update_dossier_template` read and write section dossier layouts (`ambyDossier`, §14). Roadmaps for Note pages and Creative workshop polish live in `docs/road/note-pages.md`, `docs/road/creative-ux.md` and `docs/road/creative-visual.md`.
- The sync server no longer stalls on long database work, limits event streams per device and times out stalled request bodies (sync server image `ch-20261122`).
- Native contract tests cover AI proposals and undo through the real desktop commands; a debug build can use its own app data with `AMBY_APP_DATA_DIR`. The `url` crate is updated for RUSTSEC-2026-0592.
