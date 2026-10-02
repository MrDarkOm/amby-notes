import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import type { DatabasePropertySummary } from "@/lib/storage"
import { DatabaseValueCell } from "./database-value-cell"

const properties: DatabasePropertySummary[] = [
  {
    propertyId: "status",
    name: "Status",
    propertyType: "status",
    configJson: "{}",
    options: [{ optionId: "opt-1", name: "In progress", color: "#3b82f6" }],
  },
  {
    propertyId: "relation",
    name: "Client",
    propertyType: "relation",
    configJson: "{}",
    options: [],
  },
  { propertyId: "files", name: "Files", propertyType: "files", configJson: "{}", options: [] },
]

const row = {
  noteId: "note-secret-id",
  title: "Row",
  relativePath: "Folder/Row.md",
  parentNoteId: null,
  depth: 0,
  categoryPath: [],
  valuesJson: JSON.stringify({
    status: { type: "status", optionId: "opt-1" },
    relation: { type: "relation", targetNoteIds: ["target-id"] },
    files: { type: "files", items: [{ name: "cover.png", relativePath: "assets/cover.png" }] },
  }),
  rowRevision: "revision",
}

describe("DatabaseValueCell", () => {
  it("shows names instead of technical IDs and renders text safely", () => {
    const html = renderToStaticMarkup(
      <DatabaseValueCell
        row={row}
        properties={properties}
        relationTitles={{ "target-id": "Acme" }}
      />,
    )
    expect(html).toContain("In progress")
    expect(html).toContain("Acme")
    expect(html).toContain("cover.png")
    expect(html).not.toContain("opt-1")
    expect(html).not.toContain("target-id")
    expect(html).not.toContain("note-secret-id")
    expect(html).not.toContain("src=")
  })

  it("shows a neutral placeholder for an unresolved relation", () => {
    const html = renderToStaticMarkup(<DatabaseValueCell row={row} properties={properties} />)
    expect(html).not.toContain("target-id")
    expect(html).toContain("aria-busy")
  })
})
