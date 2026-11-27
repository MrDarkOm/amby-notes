import { describe, expect, it } from "vitest"
import { isLayerDocument, naturalDocumentLayer, visibleDocumentLayer } from "./layer-documents"

const tab = (kind: "document" | "canvas" | "sketch" | "database", fileId = "id") => ({
  kind,
  fileId,
})

describe("layer documents", () => {
  it("recognises a canvas, a sketch and a database by kind, file name or buffer path", () => {
    expect(isLayerDocument(tab("canvas"))).toBe(true)
    expect(isLayerDocument(tab("sketch"))).toBe(true)
    expect(isLayerDocument(tab("database"))).toBe(true)
    expect(isLayerDocument(tab("document", "/v/a.canvas"))).toBe(true)
    expect(isLayerDocument(tab("document", "/v/a.excalidraw"))).toBe(true)
    expect(isLayerDocument(tab("document"), "/v/a.excalidraw")).toBe(true)
    expect(isLayerDocument(tab("document", "/v/a.md"), "/v/a.md")).toBe(false)
    expect(isLayerDocument(null, "/v/a.canvas")).toBe(false)
  })

  it("opens a document on its own layer, else on the editor", () => {
    expect(naturalDocumentLayer(tab("canvas"), null)).toBe("canvas")
    expect(naturalDocumentLayer(tab("document"), "/v/a.canvas")).toBe("canvas")
    expect(naturalDocumentLayer(tab("sketch"), null)).toBe("sketch")
    expect(naturalDocumentLayer(tab("document"), "/v/a.excalidraw")).toBe("sketch")
    expect(naturalDocumentLayer(tab("database"), null)).toBe("database")
    expect(naturalDocumentLayer(tab("document"), "/v/a.md")).toBe("editor")
    expect(naturalDocumentLayer(null, undefined)).toBe("editor")
  })

  it("returns an open note to Markdown when either module displaying its database is disabled", () => {
    const note = tab("database", "note-id")
    const path = "/v/Note/Note.md"
    expect(visibleDocumentLayer(note, path, "database", true, true)).toBe("database")
    expect(visibleDocumentLayer(note, path, "database", false, true)).toBe("editor")
    expect(visibleDocumentLayer(note, path, "database", true, false)).toBe("editor")
  })

  it("keeps standalone layer tabs on their own physical document", () => {
    expect(visibleDocumentLayer(tab("database"), "/v/DB/DB.json", "editor", false, true)).toBe(
      "database",
    )
    expect(visibleDocumentLayer(tab("database"), "/v/DB/DB.json", "database", true, false)).toBe(
      "database",
    )
    expect(
      visibleDocumentLayer(tab("database"), "/v/Sketch.excalidraw", "database", false, true),
    ).toBe("sketch")
  })
})
