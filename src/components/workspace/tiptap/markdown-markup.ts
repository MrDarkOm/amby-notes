import { Extension } from "@tiptap/core"

// Attaches non-rendered attributes to a few nodes/marks so the markdown layer can
// preserve the exact syntax the author used across a round-trip: `markdownMarkup`
// (`_italic_` vs `*italic*`, `+ item` vs `- item`), `markdownTitleMarkup` (the
// character that opens a link title: `"`, `'` or `(`) and `markdownPadded` (an
// ordered list whose numbers are right-aligned, ` 9.` above `10.`).
// The attributes are data-only (`rendered: false`) — they never touch the DOM,
// so they are simply absent (and fall back to a default) on HTML paste.
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
