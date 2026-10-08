import { Extension } from "@tiptap/core"

// Attaches non-rendered attributes to a few nodes/marks so the markdown layer can
// preserve the exact syntax the author used across a round-trip: `markdownMarkup`
// (`_italic_` vs `*italic*`, `+ item` vs `- item`), `markdownTitleMarkup` (the
// character that opens a link title: `"`, `'` or `(`) and `markdownPadded` (an
// ordered list whose numbers are right-aligned, ` 9.` above `10.`).
// The attributes are data-only (`rendered: false`) — they never touch the DOM,
// so they are simply absent (and fall back to a default) on HTML paste.
/** Top-level block types that keep the text they were read from. */
const BLOCK_SOURCE_TYPES = [
  "paragraph",
  "heading",
  "blockquote",
  "callout",
  "columnSet",
  "bulletList",
  "orderedList",
  "taskList",
  "codeBlock",
  "horizontalRule",
  "table",
  "footnoteDefinition",
  "opaqueHtmlBlock",
  "opaqueMarkdownBlock",
  "ambyBlock",
  "transclusion",
]

// A block of the note keeps the exact text it was read from (`markdownBlockSource`), the
// text the editor would write for it as it was read (`markdownBlockSignature`), and the
// lines that stood between it and the block before it (`markdownBlockGap`, with a key of
// that block in `markdownBlockPrev`). See markdown-block-source.ts. A new block made by
// splitting one does not inherit them.
const blockSourceAttribute = { default: null, rendered: false, keepOnSplit: false }

export const MarkdownMarkup = Extension.create({
  name: "markdownMarkup",

  addGlobalAttributes() {
    return [
      {
        types: ["italic", "bold", "bulletList"],
        attributes: {
          markdownMarkup: {
            default: null,
            rendered: false,
          },
        },
      },
      {
        types: BLOCK_SOURCE_TYPES,
        attributes: {
          markdownBlockSource: blockSourceAttribute,
          markdownBlockSignature: blockSourceAttribute,
          markdownBlockGap: blockSourceAttribute,
          markdownBlockPrev: blockSourceAttribute,
        },
      },
      {
        // An item of a top-level list keeps its own lines, what the editor would write
        // for it in its list, and the lines between it and the item before it.
        types: ["listItem", "taskItem"],
        attributes: {
          markdownItemSource: blockSourceAttribute,
          markdownItemSignature: blockSourceAttribute,
          markdownItemGap: blockSourceAttribute,
          markdownItemPrev: blockSourceAttribute,
        },
      },
      {
        types: ["link"],
        attributes: { markdownTitleMarkup: { default: null, rendered: false } },
      },
      {
        types: ["orderedList"],
        attributes: { markdownPadded: { default: null, rendered: false } },
      },
    ]
  },
})
