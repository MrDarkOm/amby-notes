// @vitest-environment happy-dom

if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = (() => ({
    filter: "",
    measureText: (text: string) => ({
      width: text.length * 10,
      actualBoundingBoxAscent: 10,
      actualBoundingBoxDescent: 2,
    }),
  })) as never
}

if (typeof globalThis.FontFace === "undefined") {
  globalThis.FontFace = class {
    load() {
      return Promise.resolve(this)
    }
  } as never
}

import * as React from "react"
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render } from "@testing-library/react"
import { parseSketch, serializeSketch } from "@/lib/sketch-format"
import { toRelativeVaultPath } from "../canvas/canvas-markdown"
import { SketchToolbar } from "./sketch-objects-toolbar"

const { convertToExcalidrawElements, restoreElements } = await import("@excalidraw/excalidraw")

describe("Excalidraw & Sketch Operations", () => {
  describe("Note Card (Embeddable) Element Creation", () => {
    it("creates a fully-formed embeddable element using restoreElements", () => {
      const relPath = "folder/my-note.md"
      const link = `amby://note/${encodeURIComponent(relPath)}`

      const [embedElement] = restoreElements(
        [
          {
            type: "embeddable",
            x: 100,
            y: 150,
            width: 320,
            height: 200,
            link,
            roundness: { type: 3 },
            strokeColor: "#3b82f6",
            backgroundColor: "#ffffff",
            fillStyle: "solid",
            strokeWidth: 1,
            roughness: 0,
          } as unknown as NonNullable<Parameters<typeof restoreElements>[0]>[number],
        ],
        null,
      )

      expect(embedElement).toBeDefined()
      expect(embedElement.type).toBe("embeddable")
      expect(embedElement.x).toBe(100)
      expect(embedElement.y).toBe(150)
      expect(embedElement.width).toBe(320)
      expect(embedElement.height).toBe(200)
      expect(embedElement.link).toBe(link)
      // Must populate all required Excalidraw element properties so Excalidraw never crashes
      expect(typeof embedElement.id).toBe("string")
      expect(embedElement.id.length).toBeGreaterThan(0)
      expect(typeof embedElement.seed).toBe("number")
      expect(typeof embedElement.version).toBe("number")
      expect(typeof embedElement.versionNonce).toBe("number")
      expect(embedElement.isDeleted).toBe(false)
      expect(embedElement.roundness).toEqual({ type: 3 })
    })

    it("correctly decodes note paths from amby://note/ links", () => {
      const originalPath = "Subfolder/Notes & Ideas/Draft #1.md"
      const encodedLink = `amby://note/${encodeURIComponent(originalPath)}`

      expect(encodedLink.startsWith("amby://note/")).toBe(true)
      const rawPath = encodedLink.slice("amby://note/".length)
      const decodedPath = decodeURIComponent(rawPath)

      expect(decodedPath).toBe(originalPath)
    })

    it("resolves relative vault path correctly", () => {
      const vault = "/Users/paul/Documents/MyVault"
      const fullPath = "/Users/paul/Documents/MyVault/projects/todo.md"

      const relPath = toRelativeVaultPath(fullPath, vault)
      expect(relPath).toBe("projects/todo.md")
    })
  })

  describe("Text Card (Rectangle + Label) Creation", () => {
    it("creates a valid rectangle element with label", () => {
      const newElements = convertToExcalidrawElements([
        {
          type: "rectangle",
          x: 50,
          y: 60,
          width: 240,
          height: 140,
          strokeColor: "#e5e7eb",
          backgroundColor: "#fef08a",
          fillStyle: "solid",
          strokeWidth: 1,
          roughness: 1,
          roundness: { type: 3 },
          label: {
            text: "Hello Excalidraw",
            fontSize: 16,
            textAlign: "center",
            verticalAlign: "middle",
          },
        },
      ])

      expect(newElements.length).toBeGreaterThanOrEqual(1)
      const rect = newElements[0]
      expect(rect).toBeDefined()
      expect(rect?.type).toBe("rectangle")
      expect(rect?.width).toBe(240)
      expect(rect?.height).toBe(140)
      expect(typeof rect?.id).toBe("string")
    })
  })

  describe("Triangle Shape Creation", () => {
    it("creates a valid closed triangle polygon using restoreElements", () => {
      const width = 160
      const height = 140
      const [triangleElement] = restoreElements(
        [
          {
            type: "line",
            x: 200,
            y: 300,
            width,
            height,
            points: [
              [width / 2, 0],
              [width, height],
              [0, height],
              [width / 2, 0],
            ],
            strokeColor: "#1e1e1e",
            backgroundColor: "transparent",
            fillStyle: "solid",
            strokeWidth: 1,
            roughness: 1,
            roundness: { type: 3 },
          } as unknown as NonNullable<Parameters<typeof restoreElements>[0]>[number],
        ],
        null,
      )

      expect(triangleElement).toBeDefined()
      expect(triangleElement.type).toBe("line")
      if (triangleElement.type === "line") {
        expect(triangleElement.points.length).toBe(4)
        // Closed polygon: first point equals last point
        expect(triangleElement.points[0]).toEqual(triangleElement.points[3])
      }
      expect(typeof triangleElement.id).toBe("string")
      expect(triangleElement.isDeleted).toBe(false)
    })
  })

  describe("Serialization and Roundtrip", () => {
    it("preserves embeddable note cards and shapes through serializeSketch and parseSketch", () => {
      const [embed] = restoreElements(
        [
          {
            type: "embeddable",
            x: 10,
            y: 20,
            width: 320,
            height: 200,
            link: "amby://note/notes/sample.md",
          } as unknown as NonNullable<Parameters<typeof restoreElements>[0]>[number],
        ],
        null,
      )

      const [triangle] = restoreElements(
        [
          {
            type: "line",
            x: 400,
            y: 100,
            width: 160,
            height: 140,
            points: [
              [80, 0],
              [160, 140],
              [0, 140],
              [80, 0],
            ],
          } as unknown as NonNullable<Parameters<typeof restoreElements>[0]>[number],
        ],
        null,
      )

      const initialSketch = {
        elements: [embed, triangle],
        appState: {
          viewBackgroundColor: "#ffffff",
          zoom: { value: 1.2 },
        },
        files: {},
      }

      const serialized = serializeSketch(initialSketch)
      expect(typeof serialized).toBe("string")

      const parsed = parseSketch(serialized)
      expect(parsed.elements.length).toBe(2)
      expect(parsed.elements[0]?.type).toBe("embeddable")
      expect(parsed.elements[0]?.link).toBe("amby://note/notes/sample.md")
      expect(parsed.elements[1]?.type).toBe("line")
      expect(parsed.appState.viewBackgroundColor).toBe("#ffffff")
    })
  })

  describe("SketchToolbar Component", () => {
    it("renders all unified toolbar buttons and triggers callbacks", () => {
      const onSelectTool = vi.fn()
      const onSelectShape = vi.fn()
      const onAddTextCard = vi.fn()
      const onAddNoteCard = vi.fn()

      const { getByTestId } = render(
        React.createElement(SketchToolbar, {
          activeTool: "selection",
          activeShape: "rectangle",
          onSelectTool,
          onSelectShape,
          onAddTextCard,
          onAddNoteCard,
        }),
      )

      // Verify all main buttons exist
      expect(getByTestId("sketch-tool-selection")).toBeDefined()
      expect(getByTestId("sketch-tool-hand")).toBeDefined()
      expect(getByTestId("sketch-object-button")).toBeDefined()
      expect(getByTestId("sketch-sticker-button")).toBeDefined()
      expect(getByTestId("sketch-tool-arrow")).toBeDefined()
      expect(getByTestId("sketch-tool-line")).toBeDefined()
      expect(getByTestId("sketch-tool-draw")).toBeDefined()
      expect(getByTestId("sketch-tool-text")).toBeDefined()
      expect(getByTestId("sketch-insert-button")).toBeDefined()
      expect(getByTestId("sketch-tool-frame")).toBeDefined()
      expect(getByTestId("sketch-tool-laser")).toBeDefined()
      expect(getByTestId("sketch-tool-eraser")).toBeDefined()

      // Click tools
      fireEvent.click(getByTestId("sketch-tool-hand"))
      expect(onSelectTool).toHaveBeenCalledWith("hand")

      fireEvent.click(getByTestId("sketch-tool-arrow"))
      expect(onSelectTool).toHaveBeenCalledWith("arrow")

      fireEvent.click(getByTestId("sketch-sticker-button"))
      expect(onAddTextCard).toHaveBeenCalled()

      fireEvent.click(getByTestId("sketch-tool-frame"))
      expect(onSelectTool).toHaveBeenCalledWith("frame")

      fireEvent.click(getByTestId("sketch-tool-laser"))
      expect(onSelectTool).toHaveBeenCalledWith("laser")

      // Click Object button -> triggers onSelectShape with current active shape and toggles flyout
      fireEvent.click(getByTestId("sketch-object-button"))
      expect(onSelectShape).toHaveBeenCalledWith("rectangle")

      // Flyout shapes should now be visible
      expect(getByTestId("sketch-shape-diamond")).toBeDefined()
      expect(getByTestId("sketch-shape-ellipse")).toBeDefined()

      // Click a shape from flyout
      fireEvent.click(getByTestId("sketch-shape-diamond"))
      expect(onSelectShape).toHaveBeenCalledWith("diamond")

      // Click Insert button -> opens insert flyout
      fireEvent.click(getByTestId("sketch-insert-button"))
      expect(getByTestId("sketch-insert-note-card")).toBeDefined()
      expect(getByTestId("sketch-insert-image")).toBeDefined()
      expect(getByTestId("sketch-insert-web-embed")).toBeDefined()

      fireEvent.click(getByTestId("sketch-insert-note-card"))
      expect(onAddNoteCard).toHaveBeenCalled()

      // Open insert flyout again to test image and web-embed
      fireEvent.click(getByTestId("sketch-insert-button"))
      fireEvent.click(getByTestId("sketch-insert-image"))
      expect(onSelectTool).toHaveBeenCalledWith("image")

      fireEvent.click(getByTestId("sketch-insert-button"))
      fireEvent.click(getByTestId("sketch-insert-web-embed"))
      expect(onSelectTool).toHaveBeenCalledWith("embeddable")
    })
  })
})
