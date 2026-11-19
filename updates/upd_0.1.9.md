# Amby 0.1.9-beta.8 — November 19, 2026

The eighth Amby 0.1.9 beta includes a command-line tool and a local MCP server for working with your vault. This release also improves saving, cross-window updates, and the responsiveness of large vaults.

## ✨ Highlights

- **Amby in the terminal.** Find and read notes, open them in Amby, and edit, rename, move, archive, or restore them with the bundled CLI. Structural edits can update backlinks and show a preview before writing.
- **Local MCP with scoped access.** Connected clients start with read-only access. You can grant edits for one folder or the entire vault. Database and workshop tools follow the workspace's module settings.
- **Safer saves and updates.** Amby flushes open edits before applying an update, keeps unsaved text available when a save fails, and shows a conflict when another editor changes the same note.
- **Faster editing and navigation.** Live editing updates the changed blocks. Background saving, lighter file watching, and targeted index updates keep large notes, folders, and database tables responsive.
- **Offline emoji and folder collections.** Emoji and flags use bundled artwork, the picker follows your search language, and a Files setting controls whether a folder click opens its collection.

> **Important.** Amby requires macOS 13 Ventura or newer. Vaults that use the earlier database format may show a migration prompt. Amby makes a backup before migrating.

> **License.** Amby 0.1.9 is distributed under GNU AGPL-3.0. Versions through 0.1.8 remain under MIT.

> **Sync backups.** New pre-sync copies live in Amby's app data and expire 14 days after the first successful sync. Existing copies beside the vault remain available. Restoring from Settings creates a separate folder. Subscription management and deleting the server copy require sync server 0.2.0.

## 🪶 Creative workshop

- With Creative and Databases enabled, MCP clients can browse workshops and stories, create workshops and sections, edit workshop details, and add manuscript pages.
- Workshop recovery preserves existing data when rolling back incomplete operations and surfaces unreadable recovery records for inspection.

## ✏️ Editor

- Live mode preserves untouched Markdown, frontmatter, and line endings. Fixes cover pasted table content, manual line breaks, unknown canvas cards, and sketches created by other apps.
- History follows an identified note across renames and moves, including changes received through sync. Safety snapshots remain available after automatic cleanup.
- Canvases, sketches, and recovery drafts follow their files when renamed or moved. Open notes and editors refresh across windows while preserving unsaved changes for conflict resolution.

## 🗃 Databases

- MCP clients can inspect schemas and rows, create databases and records, edit properties, and preview reciprocal relation changes. A folder grant must cover every record the operation will write.
- Database views refresh after sync applies a complete batch. Table rendering and cell edits are faster, and stale record revisions are rejected.

## 🗂 Interface

- Open notes, graphs, databases, canvases, and sketches in resizable workspace panes. Tabs remember their scroll position, and the start screen lists recent vaults.
- Unified search covers notes, folders, databases, canvases, text, and tags. The graph saves its layout and zoom when locked and supports back and forward navigation.
- The file tree supports dragging files and folders from the system file manager, offers sorting and filtering in its empty-area menu, and refreshes when an empty folder is deleted.
- Separate note windows use Amby's header. Sidebars animate with the workspace, and header controls align with the docks across platforms. Opening a folder in the system file manager opens that folder directly.
- Bookmark folders in Favorites, or turn a folder into a note with children from its header or context menu. The file tree groups expandable notes with folders.
- The Attachments panel shows and searches local files. Image and file drops from Finder work in notes and in the file tree.
- Notifications appear next to the dock bell. Naming and editing errors appear near the affected control, with conflict choices available from the notice.
- Document tabs work with the keyboard, and image previews and centered database dialogs manage focus while open.

## 🤖 AI panel

- The AI panel saves conversations and supports search, archive, provider settings, and removing the current note from the conversation context. Built-in Codex and Claude Code connections ask for consent before sending a conversation or reading vault content for a response.

## ☁️ Sync

- Browse and restore server versions and deleted files alongside local history. Property styling conflicts can be resolved per note.
- Sync handles large uploads and folder renames in smaller batches. You can change the account password from Settings, and deleting the server copy of a vault requires the current password.
- Sync protects local edits that arrive during downloads and refreshes the archive after each pass. Self-hosted servers reserve disk space and can reject new writes while continuing to serve reads.

## 🛠 Fixes

- Renaming and moving notes updates links in visible notes and the archive. Archive and trash operations validate their targets, including when a note shares the vault folder's name.
- Existing identifiers from other apps are preserved. An unreadable Markdown file can be isolated while the rest of the vault opens.
- Local attachments render on Windows, and IME confirmation stays within text entry. Closing and reopening a window and quitting from the macOS Dock now follow the regular save flow.
- Module installation checks signatures and package versions. The previous signing key is revoked, so packages signed with it need to be re-signed with the replacement key.

## For developers

- The CLI and MCP share vault services in the Tauri-free `amby-core` crate. MCP uses stdio, and commands that need the active vault writer use a local, user-only desktop connection.
- Installer checks cover the bundled CLI and native delegation on the Windows and Linux CI matrix. See `docs/cli.md`, `docs/mcp.md`, and `docs/sync-format.md` for configuration and protocol details.
- The watcher regression test waits for the manual scan to finish before checking that the next refresh has no pending work.
