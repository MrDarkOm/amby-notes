# Editor and boards: what is left

## Editor

Source: [editor audit](../../audit/editor-audit-2026-10/03-combined-analysis.md). The main part is done (`[[` suggestions,
search within a note, footnotes, Markdown paste, math, Mermaid, attachments, block keys, lossless Live).
Not found in the code (checked by searching file names, not by a full audit):

- toggle (`<details>`) and collapsible headings;
- `==text==` highlighting;
- table of contents, date insertion, `@` mention;
- configurable editor keys;
- not checked: block drag and drop, file drop in Tauri, reading mode, Cmd+F in the native window.

## Excalidraw board

The plan [../excalidraw-canvas-claude-plan.md](../boards.md): stages E0–E12 not started; the old
Canvas (`src/components/workspace/canvas/`) remains. Collaborative editing, cloud and AI map generation
are not part of the plan.

## Workspace

The area tree and tab transfer are done (`split-tree.ts`). A single `secondaryTabKey` is still used in
part of the code. Not checked: two areas with the same note (cursor and scroll synchronization), narrow screen.
