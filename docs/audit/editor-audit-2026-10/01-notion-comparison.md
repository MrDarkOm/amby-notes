# Amby editor vs. Notion: comparison

Date: October 7, 2026.
Status: audit, not a contract. The code was not changed. Describes the state as of this date;
check against the code and tests before working.

The combined conclusion and plan are in the [combined analysis](03-combined-analysis.md).

## How it was checked

The web version of the app (`npm run dev`, data in localStorage, the vault is untouched) and
the editor via the ProseMirror `editor`. Character-by-character typing was emulated the way
ProseMirror does it (`handleTextInput`), because the "insert the whole string" action
does not trigger the input rules. Hotkeys were synthetic `keydown` events, paste was
`view.pasteText` / `view.pasteHTML`. Speed was measured as `dispatch` timings on documents of
300–3000 paragraphs. The interface was checked with screenshots.

Not checked: block drag and drop, native Tauri features (file drop),
Cmd+F in the native window.

## What is broken or behaves differently

| #   | Problem                                                                    | How it shows up                                                                                                                                                                                                                                                                                                                                              |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Lag on long notes with links**                                           | The tags and `[[links]]` plugin (`src/components/workspace/tiptap/tags-wikilinks.ts`) recomputes decorations across the whole document on every transaction. On 3000 paragraphs without links — 1.7 ms per character, with links and tags — 69 ms; on 1000 paragraphs without links — 0.5 ms. Fixed by incremental decoration updates (`DecorationSet.map`). |
| 2   | **Pasting Markdown text does not create blocks**                           | `# Heading`, `- a`, a table, and code are pasted as raw text lines. Notion turns them into blocks. The parser (`markdownToDoc`) already exists and needs to be wired into paste. HTML from web pages pastes fine.                                                                                                                                            |
| 3   | **Backspace at the start of a heading merges it with the paragraph above** | In Notion the heading first becomes a paragraph. Here `верх` + `## Заг` became `верхЗаг`. For a list, quote, and code, Backspace turns the block into a paragraph (this is correct).                                                                                                                                                                         |
| 4   | **`- [ ] ` does not create a task**                                        | It produces a bulleted list with the text `[ ] a`. `[] ` works. `1)`, `***`, `$$`, `:smile:`, `->` do not trigger either.                                                                                                                                                                                                                                    |
| 5   | **No basic Notion hotkeys**                                                | Cmd+K (link), Cmd+Shift+↑/↓ (move a block), Cmd+D (duplicate a block), highlighter selection / Cmd+Shift+H, Cmd+Shift+X. These work: B, I, U, E, Cmd+Shift+S, Cmd+Alt+1/2, Cmd+Shift+7/8/9, Cmd+Alt+C, Cmd+Shift+B.                                                                                                                                          |
| 6   | **The `/` menu**                                                           | A separate "Поиск блока…" (Search block…) field instead of filtering as you type, 5 rows of 23 visible, no groups and no descriptions.                                                                                                                                                                                                                       |
| 7   | **Code**                                                                   | No syntax highlighting, no language label, and no "Копировать" (Copy) button on the block itself. The language can only be changed in the block panel.                                                                                                                                                                                                       |
| 8   | **Tables**                                                                 | No "+" on the edges for rows and columns, no row/column menu (insert left/right, delete, header), no cell color. A row can only be added with the Tab key in the last cell.                                                                                                                                                                                  |
| 9   | **Other**                                                                  | H1 with an underline (not in Notion). The formatting bar has no full "Turn into…". No comments and no highlighter selection.                                                                                                                                                                                                                                 |

## Notion blocks that are missing

The `/` menu has 23 blocks: paragraph, headings 1–6, bulleted and numbered lists,
tasks, code, callout, simple table, database view, quote,
divider, three ways to insert an image, file, tag, note link, emoji.

Missing:

- toggle and toggle headings;
- columns from the menu (they are created another way);
- formulas and diagrams with rendering (math and Mermaid are shown as source text);
- video, audio, PDF, and embedding by URL;
- bookmark with a link preview;
- table of contents;
- date, reminder, `@` mention;
- synced blocks, comments.

## What is already good

- Markdown shortcuts `#`, `-`, `*`, `+`, `1.`, `[]`, `>`, `---`, ` ``` `, `**`, `*`, `_`, `` ` ``, `~~` work.
- HTML paste (headings, lists, tables, code, quotes, images) and "URL over a selection" (becomes a link on the selected text) work as in Notion.
- Block handles, the formatting bar (heading, B, I, U, S, code, list, quote, callout, tag, wiki link, URL, color, AI), the block action panel (turn into, color, duplicate, delete, insert above/below, alignment, image size, callout collapse).
- Columns, databases, and AI inside a note.
- Note speed up to ~1000 paragraphs.

## What I would do

1. The lag (item 1).
2. Markdown paste, `- [ ] `, Backspace conversion, Cmd+K / Cmd+D / Cmd+Shift+↑↓ (items 2–5).
3. The `/` menu: typing directly in the text, groups, descriptions, more entries (item 6).
4. Tables and code highlighting (items 7–8).
5. New blocks: toggle, math and Mermaid, bookmarks.

## An important limitation

The goal "like Notion" runs into the rule "a file is plain Markdown". Notion blocks with no
Markdown equivalent first need a decision on how to store them losslessly. For example, a toggle
can be stored as `<details>` or as a collapsible callout `> [!note]-`; block colors cannot
be put into the file.
