# Amby editor vs. Obsidian: comparison

Date: October 7, 2026.
Status: audit, not a contract. The code was not changed.

The combined conclusion and plan are in the [combined analysis](03-combined-analysis.md).
The comparison with Notion is in a [separate file](01-notion-comparison.md).

## The main point: half of real notes open in Source

Obsidian edits the file's text itself (CodeMirror), so it cannot "break" the markup.
In Amby's Live mode the document is assembled from blocks and serialized again. If the result
does not match the file byte for byte, the note opens in Source. This is data protection (see
[Markdown compatibility](../../markdown-compatibility.md)), but in practice it triggers
too often.

### Measurement on a real vault

All `.md` files in `~/Documents/Amby` (106 notes; hidden folders and `assets` excluded;
frontmatter stripped, as the app does), the same `roundTripCheck` check
that decides admission to Live. Read only.

**53 of 106 (50%) open only in Source.** No data is lost as a result.

| Cause (by the first diverging line, heuristic)                                             | Notes | Example                         |
| ------------------------------------------------------------------------------------------ | ----- | ------------------------------- |
| Trailing space before a soft break inside a paragraph                                      | 18    | «Tässä on minun sohva. »        |
| Backslashes and escaping (`1\.`, `\-`, `$\rightarrow$`, `\*`), mostly from the web clipper | 17    | `## 1\. What are rections?`     |
| Blank lines and "loose" lists                                                              | 11    |                                 |
| List indentation                                                                           | 6     | ` 1. tammikuu`                  |
| Other                                                                                      | 1     | a link with a title `"http:/…"` |

Separate probes established that these also go to Source:

- lowercase callout types `> [!tip]`, `> [!note]-` (Obsidian is case-insensitive; Amby rewrites them to uppercase);
- tab nesting `- a⏎\t- b` (Obsidian's default) and four-space nesting;
- "loose" lists `- a⏎⏎- b`, trailing spaces in lists;
- `* * *`, setext headings (`Title⏎=====`), a line break with two spaces, indented code;
- `[^1]` footnotes, inline footnotes `^[...]`, reference definitions;
- `H~2~O`, `x^2^`.

### What to do about it

The most reliable solution: store the source text of each block (markdown-it provides a line
range via `token.map`) and write the block as is until it is edited. Then Live opens
any file without loss, like Obsidian. The price: a block that was edited is written in
normalized form (`\.` → `.`), the same in meaning, but not byte for byte. The decision is the owner's.

Quick preparatory fixes that close the most frequent causes: the space before a soft break
(18 notes) and preserving `\` escaping (17).

## Comparison by capability

| What                                                                 | Obsidian | Amby (checked)                                                                                        |
| -------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| Any note opens in Live                                               | yes      | no, 50% in Source                                                                                     |
| Suggestions when typing `[[` and `#`                                 | yes      | no (checked: no list after `[[` and `#`)                                                              |
| Search within a note (Cmd+F)                                         | yes      | no (not in Live; `searchKeymap` is not wired in Source)                                               |
| Source: search, bracket pairing, folding, line numbers, autocomplete | yes      | no: `source-editor.tsx` has only `defaultKeymap`, `history`, Markdown, and highlighting               |
| Footnotes `[^1]`                                                     | rendered | Source-only                                                                                           |
| Formulas `$x$` / `$$`                                                | MathJax  | plain text; `$$` is a raw block with no rendering                                                     |
| Mermaid                                                              | rendered | a plain code block (Mermaid rendering exists only in the canvas)                                      |
| Highlight `==text==` and comments `%%…%%`                            | yes      | plain text                                                                                            |
| Attachments `![[img.png]]`, PDF, audio, video                        | rendered | `![[x.png]]` is parsed as a note embed; an embed inside a line of text stays text; no PDF/audio/video |
| Folding headings and lists                                           | yes      | did not find it                                                                                       |
| Callout, including collapsible                                       | yes      | present, but lowercase types go to Source                                                             |
| Customizable hotkeys                                                 | yes      | global ones are customizable (`keyboard-shortcuts.ts`), editor keys are not, no Cmd+K                 |
| Command palette                                                      | yes      | did not find it (there is quick open on Cmd+P)                                                        |
| Tab nesting                                                          | yes      | Source                                                                                                |
| Reading mode                                                         | yes      | not checked                                                                                           |

## Where Amby is ahead of Obsidian

- A block interface like Notion's: block handles, the `/` menu, the formatting bar.
- Columns, databases, and AI in a note.
- A callout with a menu, a wiki link as a button, images with a size.

## What I would do

1. "Live for any note" (storing the source text of blocks).
2. `[[` and `#` suggestions, Cmd+F in a note, search and brackets in Source.
3. Rendering of formulas and Mermaid, PDF/audio/video attachments, footnotes in Live.
