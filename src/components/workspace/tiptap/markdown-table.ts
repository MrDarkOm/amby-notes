import { Table, TableCell, TableHeader } from "@tiptap/extension-table"

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

// The alignment of a column is written in the delimiter row and drawn from it
// (table-alignment.ts). The cells' own `align` attribute would be a second place for it
// that the file does not have, filled by a pasted HTML table: it is kept empty.
const noOwnAlignment = { default: null, rendered: false, parseHTML: () => null }

// A GFM cell is one line of inline text. Tiptap's cells take any blocks (`block+`); a second
// paragraph, a list or a heading made in a cell could not be written back (EDIT-01).
export const MarkdownTableCell = TableCell.extend({
  content: "paragraph",
  addAttributes() {
    return { ...this.parent?.(), align: noOwnAlignment }
  },
})

export const MarkdownTableHeader = TableHeader.extend({
  content: "paragraph",
  addAttributes() {
    return { ...this.parent?.(), align: noOwnAlignment }
  },
})
