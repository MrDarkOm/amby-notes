import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { DatabaseValueCell } from "./database-value-cell"

describe("DatabaseValueCell", () => {
  it("renders relation IDs and file names as safe text", () => {
    const html = renderToStaticMarkup(
      <DatabaseValueCell
        row={{
          noteId: "note",
          title: "Row",
          relativePath: "Row.md",
          parentNoteId: null,
          depth: 0,
          categoryPath: [],
          valuesJson: JSON.stringify({
            relation: { type: "relation", targetNoteIds: ["target"] },
            files: {
              type: "files",
              items: [{ name: "cover.png", relativePath: "assets/cover.png" }],
            },
          }),
          rowRevision: "revision",
        }}
      />,
    )
    expect(html).toContain("target")
    expect(html).toContain("cover.png")
    expect(html).not.toContain("src=")
  })
})
