# Amby 0.1.9-beta.9 — November 22, 2026

The ninth Amby 0.1.9 beta lets the AI panel propose changes to your notes, folders and databases, which you apply or undo. It also makes Supernotes an optional module, replaces several confirmation questions with Undo, and adds Templates and Daily notes. The command-line tool and local MCP server from beta 8 gain more tools.

> **Updater fix, November 23.** If you run beta 8 or the original beta 9, install the refreshed beta 9 manually from this release. This build can download signed updates and install them after saving open edits.

## ✨ Highlights

- **The AI panel can edit, with your approval.** It proposes new notes, added or replaced text, property changes, database rows and cells, moves, renames, archiving and deletions as cards. Apply each one yourself, or choose Auto or Turbo, and undo any applied change from its card.
- **Undo instead of questions.** Renaming or moving a note that updates links in other notes, and merging two notes, happen at once. A line under the tree and a notification entry offer «Restore», which puts everything back exactly.
- **Supernotes as a module.** Switch Supernotes off for a vault in Settings → Modules: existing supernotes open as ordinary folders, nothing in your files is rewritten, and switching it back restores them.
- **Templates and Daily notes.** Create notes from templates kept in your vault, and turn on Daily notes in Settings → Modules.
- **Amby in the terminal and in AI agents.** The bundled CLI and local MCP server read and change notes, properties, attachments and links, and connect to Claude Code, Codex, Cursor or Antigravity from Settings with read-only or write access.

> **Important.** Amby requires macOS 13 Ventura or newer. Vaults that use the earlier database format may show a migration prompt. Amby makes a backup before migrating.

> **License.** Amby 0.1.9 is distributed under GNU AGPL-3.0. Versions through 0.1.8 remain under MIT.

> **Sync backups.** New pre-sync copies live in Amby's app data and expire 14 days after the first successful sync. Existing copies beside the vault remain available. Restoring from Settings creates a separate folder. Subscription management and deleting the server copy require sync server 0.2.0.

## 🤖 AI panel

- The AI proposes changes as cards that show exactly what will change and every file a move, rename, archive or deletion touches. Nothing is written until you apply it; Undo restores the previous text, properties, rows or place. A note with unsaved edits waits until it is saved.
- Approval modes: Manual (you apply every card), Auto (text, property and database changes apply at once with Undo) and Turbo (moves, renames and archiving apply at once too). Deletions always wait for you and follow your deletion setting.
- The AI reads notes by section, sees properties, note info, earlier versions, tags and databases, and can find a note by its title. A database you add to the conversation can be read and changed without turning on vault search.
- Attach a text file, a note or a folder from the paperclip menu. Steps name what was read or prepared, answers keep their paragraphs, and the AI knows which note is open now.
- The AI panel saves conversations and supports search, archive and provider settings. Built-in Codex and Claude Code connections ask for consent before sending a conversation or reading vault content.

## 🪶 Creative workshop

- With Creative and Databases enabled, MCP clients can browse workshops and stories, create workshops and sections, edit workshop details, and add manuscript pages.
- Workshop recovery preserves existing data when rolling back incomplete operations and surfaces unreadable recovery records for inspection.

## ✏️ Editor

- Live mode preserves untouched Markdown, frontmatter, and line endings. Fixes cover pasted table content, manual line breaks, unknown canvas cards, and sketches created by other apps.
- History follows an identified note across renames and moves, including changes received through sync. Safety snapshots remain available after automatic cleanup.
- Canvases, sketches, and recovery drafts follow their files when renamed or moved. Open notes and editors refresh across windows while preserving unsaved changes for conflict resolution.
- Renaming or moving keeps the style of links: a link by name stays a name when that name is unique.

## 🗃 Databases and Supernotes

- Supernotes is a module: with it off, folder conversion and layer management are hidden, a supernote's files show as a folder, and the command line, MCP and the AI panel treat its text file as a single file.
- The sidebar can add a text layer to a database, and removing one keeps the rest of the bundle. Open notes show a newly attached database at once.
- MCP clients can inspect schemas and rows, create databases and records, edit properties, and preview reciprocal relation changes. A folder grant must cover every record the operation will write.
- Database views refresh after sync applies a complete batch. Table rendering and cell edits are faster, and stale record revisions are rejected. The folder view labels databases and sketches correctly.

## 🗂 Interface

- Templates: create a note from a template, and make a new template from the template dialog. Daily notes, off by default, open today's note from the dock.
- Settings: the font size and the tooltip delay are smooth sliders, AI agents are a row of tiles with their status, App data uses ordinary rows, and an About section shows the version and licenses. Every section has the same margins.
- Dock menus have the same order everywhere, and slide-out side panels are one floating sheet. Below 960 px, opening one side panel closes the other.
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

- Renaming and moving notes updates links in visible notes and the archive. Archive and trash operations validate their targets, including when a note shares the vault folder's name.
- Existing identifiers from other apps are preserved. An unreadable Markdown file can be isolated while the rest of the vault opens.
- Local attachments render on Windows, and IME confirmation stays within text entry. Closing and reopening a window and quitting from the macOS Dock now follow the regular save flow.
- Module installation checks signatures and package versions. The previous signing key is revoked, so packages signed with it need to be re-signed with the replacement key.

## For developers

- The CLI and MCP share vault services and the tool set in the Tauri-free `amby-core` crate, including the engine for AI proposals and exact undo. See `docs/cli.md`, `docs/mcp.md`, `docs/ai-harness.md` and `docs/sync-format.md`.
- The sync server no longer stalls on long database work, limits event streams per device and times out stalled request bodies (sync server image `ch-20261122`).
- Native contract tests cover AI proposals and undo through the real desktop commands; a debug build can use its own app data with `AMBY_APP_DATA_DIR`. The `url` crate is updated for RUSTSEC-2026-0592.
