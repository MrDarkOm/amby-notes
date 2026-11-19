import { describe, expect, it } from "vitest"
import { isLayerDocument, naturalDocumentLayer } from "./layer-documents"

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
})
