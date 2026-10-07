// Synthetic notes for the real-browser suite. They are TypeScript strings, not `.md`
// files, so that neither Prettier nor Git line-ending handling can touch a byte of them.

const lines = (...rows: string[]) => rows.join("\n") + "\n"

/** Two titled links around images: this shape once froze the window in Live. */
export const TITLED_IMAGE_LINKS = lines(
  "# Social",
  "",
  '- [![A](https://example.invalid/a.png)](https://example.invalid/a "A")',
  '- [![B](https://example.invalid/b.png)](https://example.invalid/b "B")',
)

const TABLE_COLUMNS = 8
const TABLE_ROWS = 250

/** About 2000 table cells in one note. */
export const HEAVY_TABLE = (() => {
  const header = `| ${Array.from({ length: TABLE_COLUMNS }, (_, c) => `Col ${c + 1}`).join(" | ")} |`
  const delimiter = `| ${Array.from({ length: TABLE_COLUMNS }, () => "---").join(" | ")} |`
  const rows = Array.from(
    { length: TABLE_ROWS },
    (_, r) =>
      `| ${Array.from({ length: TABLE_COLUMNS }, (_, c) => `r${r + 1}c${c + 1}`).join(" | ")} |`,
  )
  return lines("# Heavy table", "", header, delimiter, ...rows, "", "After the table.")
})()
export const HEAVY_TABLE_CELLS = TABLE_COLUMNS * (TABLE_ROWS + 1)

/** Spellings the editor reads but would write differently: all must survive untouched. */
export const ODD_SPELLINGS = lines(
  "Setext title",
  "============",
  "",
  "1\\. A web clipper escaped this number.",
  "",
  "- sparse one",
  "",
  "- sparse two",
  "",
  "* * *",
  "",
  "Second level",
  "------------",
  "",
  "> [!tip] lowercase callout",
  "> Body of the callout.",
  "",
  "Italic around bold: ***word**.* and **a **b** c** here.",
  "",
  "1) first",
  "2) second",
  "",
  "Plain paragraph to edit.",
  "",
  "Last   paragraph   with   spaces.",
)

/** A footnote reference and its definition: Live with the blocks kept as source text. */
export const FOOTNOTE = lines(
  "# Footnote",
  "",
  "Ordinary paragraph.",
  "",
  "A claim with a note.[^1]",
  "",
  "[^1]: The note itself.",
  "",
  "Closing paragraph.",
)

export const SOURCE_LINES = lines("Line one", "", "Line three")

/** A link definition keeps a note in Source: the editor would drop it when rebuilding. */
export const SOURCE_ONLY = lines("See [the site][site].", "", "[site]: https://example.invalid/")
