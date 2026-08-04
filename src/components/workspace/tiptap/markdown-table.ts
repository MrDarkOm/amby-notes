import { Table } from "@tiptap/extension-table"

// markdown-it exposes the original table delimiter as a token-level detail.
// Keep it on the ProseMirror node so a Live Preview edit does not normalize
// `:---`, `---:`, spacing, or the user's chosen number of dashes.
export const MarkdownTable = Table.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      markdownSeparator: {
        default: null as string | null,
        rendered: false,
      },
      markdownSource: {
        default: null as string | null,
        rendered: false,
      },
      markdownSignature: {
        default: null as string | null,
        rendered: false,
      },
    }
  },
})
