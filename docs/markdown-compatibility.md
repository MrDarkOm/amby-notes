# Markdown compatibility matrix

This document is the executable compatibility contract for M2. The Markdown
file remains the source of truth: a document may enter Live Preview only when
parsing and serializing it produces exactly the same bytes. Otherwise Amby
opens the document in Source mode, where it is edited as raw text.

The matrix certifies compatibility and data preservation, not necessarily a
special visual widget for every construct. For example, Mermaid and math may
remain portable Markdown text/code until their dedicated renderer is enabled;
their source is still preserved exactly.

## Status legend

| Status               | Meaning                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| **Live, byte-exact** | Covered by a golden round-trip test. It may be opened and saved in Live Preview.                         |
| **Source-only**      | Kept untouched in Source mode. Live Preview is intentionally blocked until a lossless node/token exists. |
| **Planned**          | Not yet a supported M2 contract.                                                                         |

## Syntax matrix

| Syntax                                                                 | Status                     | Notes                                                                                                                                                                                          |
| ---------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Headings, paragraphs, emphasis, strong, strike-through and inline code | **Live, byte-exact**       | Preserves the user's `*`/`_` and `**`/`__` choice where supported by the parser. Leading/terminal blank lines and consistent LF/CRLF formatting are retained at the editor boundary.           |
| Fenced code blocks and unknown fence languages                         | **Live, byte-exact**       | Fence length and language are preserved.                                                                                                                                                       |
| Bullet, ordered and task lists                                         | **Live, byte-exact**       | Nested-list cases are covered separately before being promoted to the contract.                                                                                                                |
| Blockquotes and horizontal rules                                       | **Live, byte-exact**       |                                                                                                                                                                                                |
| Links, images, tags and Obsidian wikilinks                             | **Live, byte-exact**       | Wikilink aliases, headings and block anchors are kept as raw link content.                                                                                                                     |
| Amby block columns                                                     | **Live, byte-exact**       | Column boundaries use invisible `amby:columns` HTML comments; the content inside every column remains ordinary portable Markdown.                                                              |
| Note transclusions (`![[...]]`)                                        | **Live, byte-exact**       | Alias and anchor remain on disk while the preview resolves the base target.                                                                                                                    |
| GFM tables, including alignment                                        | **Live, byte-exact**       | Preserves alignment markers, delimiter spacing and dash count until the table structure changes.                                                                                               |
| Amby text colour and underline HTML                                    | **Live, byte-exact**       | Restricted to the safe `span style` and `u` forms handled by the editor.                                                                                                                       |
| YAML frontmatter                                                       | **Live body, opaque YAML** | Live Preview does not edit YAML, but a body-only save preserves the complete YAML envelope byte-for-byte, including comments, key order and unknown forms.                                     |
| Footnotes                                                              | **Source-only**            | markdown-it can reinterpret definitions contextually; the guard keeps them out of Live Preview until citation tokens exist.                                                                    |
| Reference-style links                                                  | **Source-only**            | The parser resolves and normalizes definitions, so Live Preview remains blocked until they have opaque tokens.                                                                                 |
| Raw HTML, comments, iframes, audio/video/PDF embeds                    | **Live, opaque block**     | Block HTML is preserved as source text and never executed or normalized by the visual editor. Transclusion previews escape raw HTML as inert text. Raw inline HTML uses an opaque inline atom. |
| Obsidian callouts, including foldable and custom variants              | **Live, byte-exact**       | Fold markers, headers and custom callout types are retained; editing the icon intentionally regenerates the header.                                                                            |
| Mixed CRLF/LF line endings                                             | **Source-only**            | Their exact distribution needs a token-level on-disk model.                                                                                                                                    |
| MathJax source and Mermaid fences                                      | **Live, byte-exact**       | Block math is held as an opaque source block; Mermaid remains a portable code fence. Dedicated MathJax/Mermaid rendering may be layered on without changing the file format.                   |

## Test fixtures

- `src/components/workspace/tiptap/fixtures/live-preview-safe.md` is the
  golden fixture for syntax admitted to Live Preview.
- `src/components/workspace/tiptap/fixtures/obsidian-compat.md` exercises
  opaque frontmatter, foldable callouts, tables, footnotes and raw HTML.
  Footnotes deliberately keep this fixture in Source mode; frontmatter is kept
  by the Rust write boundary.
- `src/components/workspace/tiptap/fixtures/malformed-frontmatter.md` verifies
  that malformed YAML is never passed through visual serialization.
- `tests/fixtures/markdown-compatibility.json` is the shared cross-platform
  corpus executed by both TypeScript (Vitest) and Rust (`cargo test`) to ensure
  identical indexing of tags, wikilinks, targets, labels and protected regions
  (code fences, inline code, comments, frontmatter) between web fallback and
  desktop Tauri index.

The unit suite also generates a deterministic 80-document compatibility corpus.
Every generated document must either be byte-exact or be rejected by the Live
Preview guard before it can be saved. This is a lightweight fuzz regression
guard without a non-reproducible test seed.

Selection is transferred between Source and Live Preview using a local textual
anchor. The Markdown bytes and editor history are not changed by a mode
transition; if an anchor is ambiguous, the nearest valid cursor position is
used. Since every admitted Live Preview document has an exact byte comparison,
the automated re-open compatibility check is equivalent to opening the original
file in Obsidian: its bytes are unchanged.

When adding a Live Preview feature, add a fixture or focused round-trip case
first. When a construct cannot be serialized byte-for-byte, keep it
Source-only rather than normalizing the note.
