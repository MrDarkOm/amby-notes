# Amby editor: independent combined analysis

Date: October 7, 2026.
Status: audit, not a contract. The application code was not changed.

A review of the three previous documents: [Notion](01-notion-comparison.md),
[Obsidian](02-obsidian-comparison.md), [combined analysis](03-combined-analysis.md).
Their claims were re-checked against the code, and the main figures were re-measured.

## Conclusion

The audits' main diagnosis is correct: the editor is already good as a block interface, and its
weak spot is the half of notes that open only in Source. The task
"Live for any note" really is first.

I disagree with the audits in three places:

1. **The "quick preparatory fixes" will give almost nothing.** The audit promises 18 + 17 notes from
   two small fixes. By my measurement, fixing trailing line spaces returns 5 notes to
   Live, and all four simple fixes together return the same 5. A note usually has
   several causes at once, while the audit counted only the first.
2. **The lag is not a critical problem.** It reproduces only on an artificial
   note with thousands of links. In the real vault the plugin spends no more than 0.41 ms.
3. **"The same in meaning" is not always true.** When a block is rebuilt, the editor silently loses
   link titles (`[text](url "title")`). Right now falling back to
   Source protects against this. If such notes are simply opened in Live, the protection disappears.

## What was re-measured

The same 106 notes from `~/Documents/Amby`, the same `roundTripCheck` check, read
only. The temporary test file was deleted after the measurement.

| Metric                                                 | Value                                |
| ------------------------------------------------------ | ------------------------------------ |
| Notes only in Source                                   | 53 of 106 (matches the audit)        |
| Share of the vault's text in these notes               | 92% (376 of 407 thousand characters) |
| Top-level blocks in these notes                        | 1189                                 |
| Of them, not reproduced byte for byte                  | 327 (27%; median per note 31%)       |
| Notes where the rebuild gives the same editor document | 42 of 53                             |
| Notes where a second rebuild changes nothing more      | 51 of 53                             |

What follows from this:

- **The problem is bigger than "half".** Long and substantial notes go to Source.
  Mostly short ones open in Live.
- **Three quarters of the blocks in the "bad" notes are already fine.** A minority of blocks
  sends the whole note to Source. This is a direct argument for storing the source
  text per block.
- **Normalization is almost always harmless.** Of 11 notes with differences in the document,
  10 differ only in the tables' service attributes (they hold the source text), and one
  in text formatting. A caveat: the check does not see what the parser discarded
  already during reading (link titles).

### Why blocks do not match

| Cause                                                  | Blocks | Where                                           |
| ------------------------------------------------------ | ------ | ----------------------------------------------- |
| Backslashes (`1\.`, `\-`), mostly from the web clipper | 165    | paragraphs 75, headings 60, lists 17, tables 13 |
| Blank lines and breaks inside lists                    | 62     | bulleted 50, numbered 12                        |
| Slashes together with spaces and indentation           | 44     | lists, paragraphs, tables                       |
| Marker choice (`*` / `-` / `_`)                        | 28     | paragraphs, tables                              |
| Trailing spaces                                        | 11     | paragraphs                                      |
| Other                                                  | 17     | see below                                       |

The classification is rough: it compares the block text before and after, discarding one
class of characters.

### What the audits did not notice

- **A numbered list of 10 or more items always goes to Source.** The serializer
  aligns the numbers with spaces (` 1.` … `10.`,
  `markdown-serializer.ts`, `orderedList`). The audit recorded this as "list indentation in the
  file" with the example ` 1. tammikuu`, but the space is added by the editor itself. Such lists
  exist in 11 notes.
- **Link titles are lost** (5 notes): the parser takes only `href` from a link.
- **Tables fail to match more often than the contract promises:** 32 of 107. The causes are slashes
  in cells and aligning cell widths to a single space. The contract speaks of
  preserving a table until its structure is changed.
- **One note with nine frontmatter blocks in a row**, each with its own `id` (a file
  with CRLF, modified on September 1). This is not about the editor but about ID assignment; moved
  to a separate task. The file was not touched.

## Checking the claims against the code

| Audit claim                                              | Result                       | Basis                                                                                                    |
| -------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| 53 of 106 in Source                                      | confirmed                    | repeated measurement                                                                                     |
| The link plugin recomputes the whole document            | confirmed                    | `tags-wikilinks.ts`: `decorations(state)` walks the document; it also fires on cursor movement           |
| 69 ms per character on 3000 paragraphs                   | order of magnitude confirmed | computation only, without rendering: 53 ms; 1000 paragraphs — 6 ms; 300 — 0.9 ms; without links — 0.2 ms |
| Markdown paste does not create blocks                    | confirmed                    | the only `handlePaste` is in `media-drop.ts`, for files                                                  |
| No Cmd+K, Cmd+D, block moving                            | confirmed                    | own keys: Tab, Backspace, `[`, `#`, Cmd+U                                                                |
| `- [ ] ` does not create a task                          | plausible                    | there are no custom input rules, the standard ones apply; not checked in the UI                          |
| No `[[` and `#` suggestions                              | confirmed                    | there is one `Suggestion`, for `/`                                                                       |
| No search, brackets, folding in Source                   | confirmed                    | `source-editor.tsx`; the `@codemirror/search` package is not in the dependencies                         |
| No code highlighting and formula rendering               | confirmed                    | no `lowlight`, `katex`; Mermaid only in the canvas                                                       |
| Backspace in a heading, the look of the `/` menu, tables | not checked                  | requires running the UI                                                                                  |

The plugin's time grows faster than linearly: three times as many paragraphs — 8.5 times longer.

## Remarks on the decision to "store the source text of blocks"

The direction is right. What to take into account before starting:

1. **First remove the losses of meaning.** A link title must become an attribute.
   Footnotes and reference definitions must remain opaque blocks that
   Live shows but does not rebuild. Without this, opening "any note" in Live
   trades data protection for convenience.
2. **The unit is a top-level block, and that is coarse for lists.** Editing a single
   item normalizes the whole list, and lists fail to match most often (76 of 110
   bulleted ones). As a second step, text should be stored per item.
3. **The gaps between blocks also need to be stored** (the number of blank lines), otherwise a
   note will not match even without edits.
4. **A new verifiable invariant.** "Opened and saved without edits — the file is the same
   byte for byte" for any file, including the whole compatibility set. Plus:
   a normalized block, when read again, gives the same document.
5. **The contract changes.** Now: "Live only on a byte-for-byte match of the whole
   file". It will become: "untouched — byte for byte, an edited block — normalized".
   [Markdown compatibility](../../markdown-compatibility.md) must be rewritten in the same
   package.
6. **Insurance.** A snapshot into history before the first save that normalizes
   a note's block.

Fixing the alignment of numbered lists and table cell widths is needed in any
case: it reduces the number of blocks that change on an edit.

## Order of work

1. **Live for any note** — in the order from the section above: losses of meaning, then
   storing block text, then lists per item.
2. **Small input fixes:** Markdown paste, `- [ ] `, Backspace in a heading,
   Cmd+K, Cmd+D, block moving. Cheap and noticeable every day.
3. **`[[` and `#` suggestions, Cmd+F.** I put them above the `/` menu and tables: for an app
   with linked notes, a link suggestion is a basic thing. Source tools
   (search, bracket pairing) are a few lines and one package; after item 1 Source is needed
   less often, so folding and line numbers can be skipped.
4. **Incremental link decorations.** A small fix, to be done together with item 3 in
   the same file. I do not count it as a separate priority.
5. **The `/` menu, tables, code highlighting.**
6. **New blocks.** First those that do not change the file format: rendering of formulas and
   Mermaid. A toggle is the existing collapsible callout (`> [!note]-`),
   no new format is needed. PDF, audio, and video attachments, bookmarks — after the decision on
   storage.

## Owner decision

Accepted on October 7, 2026: a block that was edited is written in
normalized form; untouched blocks are written byte for byte as they were. The conditions
are mandatory and are met before enabling: 1 (losses of meaning removed), 4 (the test "opened
and saved without edits — the file is the same") and 6 (a snapshot into history) from the section above.
The contract in [Markdown compatibility](../../markdown-compatibility.md) changes in the same
package as the code.

## What was done after the audit

Step 1 (link titles, alignment of numbered lists) and storing the source
text of top-level blocks were done on October 7, 2026; the current contract is
in [Markdown compatibility](../../markdown-compatibility.md). A measurement on the same vault:
3 notes of 106 in Source (was 53, after step 1 — 50), saving without edits
gives the same bytes for all 106. The three remaining notes are nested emphasis,
which the editor writes differently. Storing text per list item is not started.

## What was not checked

Behavior in the UI (Backspace, the `/` menu, hotkeys live), speed in the
browser with rendering, the native Tauri window. The simulation of the "quick preparatory fixes" is
an edit of the source text, not of the serializer: a real fix may return a
few more notes, but the order of magnitude will not change.
