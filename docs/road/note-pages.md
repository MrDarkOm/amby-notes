# Note Pages roadmap

Status as of 2026-11-26: **six editor features implemented; templates planned**. These items extend the shared
[note pages editor](../../src/components/workspace/editor/MAP.md) wherever a note offers pages.

| Priority | Item                         | Status      |
| -------- | ---------------------------- | ----------- |
| 1        | Restore the last open page   | Implemented |
| 2        | Link to a page               | Implemented |
| 3        | Reorder pages                | Implemented |
| 4        | Find matches by page         | Implemented |
| 5        | Move blocks to a new page    | Implemented |
| 6        | Go to a page by name         | Implemented |
| Later    | Create pages from a template | Planned     |

1. **Restore the last open page.** Remember the selected page for each note across reopens.
   Done when reopening a note returns to the last page used. If it was removed, open the first available page.
2. **Link to a page.** Add a copy-link action to the tab menu and use the existing Markdown heading
   link conventions. Done when following the copied link opens the destination note on the right tab.
3. **Reorder pages.** Drag a tab or a row in the compact list. The page follows the pointer and the other
   pages slide to preview the order. Dropping moves the heading and its content together, including nested
   headings. If the introduction moves away from the start, it gets an Introduction heading so
   its text stays separate. Whole Note shows the same order, and Undo restores the previous order.
4. **Find matches by page.** Keep pages open during Find. The match list names each page, and picking a result opens its tab and highlights the match.
5. **Move blocks to a new page.** Select text and choose the new-page action under the add button. It moves the complete blocks touched by the selection and opens the new tab. Undo restores the original order.
6. **Go to a page by name.** When the tabs fold into a compact list, use its Go to page action or
   Mod+Alt+G while the note has focus. Filter by name and press Enter to open the selected page.

**Create pages from a template.** Let templates open a new note with editable starter tabs.
One example is a storyline template with Premise, Development, and Ending as working labels.
