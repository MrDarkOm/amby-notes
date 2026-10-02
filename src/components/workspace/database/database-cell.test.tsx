import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import "@/lib/i18n"
import { DatabaseCell } from "./database-cell"

describe("DatabaseCell", () => {
  it("shows a stored relation as a loading chip, never as its raw note ID", () => {
    const noteId = "01J00000000000000000000002"
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
          "01J00000000000000000000000": { type: "relation", targetNoteIds: [noteId] },
        })}
        pending={false}
        onCommit={async () => undefined}
      />,
    )

    expect(html).not.toContain(noteId)
    expect(html).toContain("aria-busy")
    // Unlinking stays possible while the title is still loading.
    expect(html).toContain("<button")
  })

  describe("computed cells", () => {
    const rollup = {
      propertyId: "r",
      name: "Progress",
      propertyType: "rollup",
      configJson: JSON.stringify({ aggregation: "percentChecked" }),
      options: [],
    }
    const render = (valuesJson: string, computedError?: string) =>
      renderToStaticMarkup(
        <DatabaseCell
          property={rollup}
          valuesJson={valuesJson}
          pending={false}
          computedError={computedError}
          onCommit={async () => undefined}
        />,
      )

    it("shows the value, with a percent sign for a share", () => {
      expect(render(JSON.stringify({ r: { type: "number", decimal: "60.00" } }))).toContain("60%")
    })

    it("shows zero as zero and an empty rollup as no data", () => {
      expect(render(JSON.stringify({ r: { type: "number", decimal: "0" } }))).toContain(">0%<")
      expect(render(JSON.stringify({ r: { type: "null" } }))).toContain("нет данных")
    })

    it("shows an error only when the calculation failed, not for an unset cell", () => {
      expect(render("{}", "overflow")).toContain("Ошибка вычисления")
      expect(render("{}")).not.toContain("Ошибка")
    })
  })
})
