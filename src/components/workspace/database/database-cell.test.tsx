import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import "@/lib/i18n"
import { DatabaseCell } from "./database-cell"

describe("DatabaseCell", () => {
  it("edits a relation using records from its current database", () => {
    const html = renderToStaticMarkup(
      <DatabaseCell
        property={{
          propertyId: "01J00000000000000000000000",
          name: "Related",
          propertyType: "relation",
          configJson: "{}",
          options: [],
        }}
        valuesJson={JSON.stringify({
          "01J00000000000000000000000": {
            type: "relation",
            targetNoteIds: ["01J00000000000000000000002"],
          },
        })}
        relationOptions={[
          { noteId: "01J00000000000000000000001", title: "Alpha" },
          { noteId: "01J00000000000000000000002", title: "Beta" },
        ]}
        pending={false}
        onCommit={async () => undefined}
      />,
    )

    expect(html).toContain("Beta")
  })
})
