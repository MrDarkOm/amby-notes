import { Extension } from "@tiptap/core"

// Attaches a non-rendered `markdownMarkup` attribute to a few nodes/marks so the
// markdown layer can preserve the exact syntax marker the author used
// (e.g. `_italic_` vs `*italic*`, `+ item` vs `- item`) across a round-trip.
// The attribute is data-only (`rendered: false`) — it never touches the DOM,
// so it is simply absent (and falls back to a default) on HTML paste.
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
    ]
  },
})
