# Amby editor: combined analysis (Notion + Obsidian)

Date: October 7, 2026.
Status: audit, not a contract. The code was not changed as part of the analysis.

Details and methodology: [comparison with Notion](01-notion-comparison.md),
[comparison with Obsidian](02-obsidian-comparison.md).

## Verdict

As a block editor (interface, handles, menus, columns, databases), the Amby editor is already close to
Notion. As a Markdown file editor it is weaker than Obsidian: half of real notes
open in Source, and Source lacks the tools familiar from Obsidian. In Notion and
Obsidian, convenience starts with the text never "falling apart". So
there is one main task: Live must open any file without loss.

## Critical (confirmed by measurements)

| #   | Problem                                          | Data                                                                                                                                                                                                                                                    | Source   |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | **Half of notes open in Source**                 | 53 of 106 in the vault. Causes: a space before a soft break (18), `\` escaping from the web clipper (17), blank lines (11), list indentation (6), other (1). Also lowercase `[!tip]`, tab nesting, `* * *`, setext, a break with two spaces, footnotes. | Obsidian |
| 2   | **Lag on long notes with links**                 | 69 ms per character vs. 1.7 ms without links (3000 paragraphs): the `tags-wikilinks` plugin recomputes decorations across the whole document on every edit.                                                                                             | both     |
| 3   | **Pasting Markdown text does not create blocks** | `# Heading`, `- a`, a table are pasted as raw text lines. The parser already exists. HTML pastes fine.                                                                                                                                                  | both     |

## Bugs and behavior annoyances

- **Backspace at the start of a heading** merges it with the paragraph above; in Notion it first turns into a paragraph.
- **`- [ ] ` does not create a task** (it produces a list with the text `[ ]`), and `1)` and `***` do not work either.
- **Missing keys:** Cmd+K (link), Cmd+Shift+↑/↓ (move a block), Cmd+D (duplicate), highlighter selection.
- **The `/` menu:** a separate search field instead of filtering as you type, 5 rows of 23 visible, no groups and no descriptions.
- **Code:** no highlighting, no language label, and no "Копировать" (Copy) button on the block.
- **Tables:** no "+" on the edges and no row/column menu, no cell color.
- **Other:** an underline under H1 (not in Notion), a formatting bar without a full "Turn into…".

## Missing capabilities (summary)

| Capability                                                                 | Notion           | Obsidian      | Amby                                        |
| -------------------------------------------------------------------------- | ---------------- | ------------- | ------------------------------------------- |
| Suggestions when typing `[[` and `#`                                       | yes              | yes           | no                                          |
| Search within a note (Cmd+F)                                               | yes              | yes           | no                                          |
| Source: search, bracket pairing, folding, line numbers                     | —                | yes           | no                                          |
| Toggle, collapsible headings                                               | yes              | yes (folding) | no                                          |
| Formulas and Mermaid with rendering                                        | yes              | yes           | no (text / plain code)                      |
| Attachments and embedding (image, PDF, audio, video, bookmark, `![[img]]`) | yes              | yes           | no (`![[x.png]]` is parsed as a note embed) |
| Footnotes `[^1]`                                                           | no               | yes           | Source-only                                 |
| Highlight `==text==`, comments `%%`                                        | color / comments | yes           | plain text                                  |
| Date, `@` mention, table of contents                                       | yes              | partly        | no                                          |
| Customizable editor keys                                                   | no               | yes           | no (global ones are customizable)           |

## What is already good

- Markdown shortcuts `#`, `-`, `1.`, `[]`, `>`, ` ``` `, `---`, `**`, `*`, `` ` ``, `~~`.
- HTML paste and "URL over a selection" work as in Notion.
- Block handles, the formatting bar, a callout with a menu.
- Columns, databases, and AI in a note, images with a size.
- A wiki link is displayed as a button, tags are highlighted.
- Speed for notes up to ~1000 paragraphs.
- Fixed in the October 7 session: Tab and spaces (indentation, spaces at the start and end of a paragraph), Live no longer drops to Source because of typing, notes with "raw" whitespace-only lines open in Live, deletion to the system trash on macOS without Finder.

## Single plan by priority

1. **Live for any note.** Store the source text of blocks and write it as is until the block is edited (the biggest task). Quick preparatory fixes: a space before a soft break (18 notes), preserving `\` escaping (17), tabs and list indentation, lowercase callouts, loose lists. Result: Source only by the user's choice.
2. **Speed:** incremental decorations for links and tags.
3. **Quick wins:** Markdown paste, `- [ ] `, Backspace, Cmd+K / Cmd+D / Cmd+Shift+↑↓.
4. **Navigation:** `[[` and `#` suggestions, Cmd+F in a note, tools in Source (search, brackets, folding).
5. **The `/` menu and tables:** typing directly in the text, groups, descriptions, a row and column interface.
6. **New blocks:** toggle, formulas and Mermaid with rendering, attachments (PDF, audio, video), footnotes, code highlighting.

## Owner decisions

- **Lossless storage of blocks in Markdown** (toggle as `<details>` or a collapsible callout, formulas, attachments). Block colors cannot be put into the file.
- **Normalization on edit:** a block changed after item 1 is written in normalized form (`\.` → `.`): the same in meaning, but not byte for byte.

## What was not checked

Block drag and drop, native Tauri features (file drop), reading mode, Cmd+F in the
native window, the visual rendering of `![[img]]`. The shares and causes across the vault were counted
by a heuristic on the first diverging line.
