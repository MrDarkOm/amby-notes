import { describe, expect, it } from "vitest"
import {
  createDefaultSketch,
  parseSketch,
  serializeSketch,
  validateAndSerializeSketch,
} from "./sketch-format"

describe("sketch-format", () => {
  it("creates a valid default sketch document", () => {
    const defaultDoc = createDefaultSketch()
    expect(defaultDoc.type).toBe("excalidraw")
    expect(defaultDoc.version).toBe(2)
    expect(defaultDoc.elements).toEqual([])
    expect(defaultDoc.appState.viewBackgroundColor).toBe("#ffffff")
    expect(defaultDoc.files).toEqual({})
  })

  it("parses empty, null, or invalid JSON into default sketch", () => {
    expect(parseSketch("")).toEqual(createDefaultSketch())
    expect(parseSketch(null)).toEqual(createDefaultSketch())
    expect(parseSketch(undefined)).toEqual(createDefaultSketch())
    expect(parseSketch("{ invalid json")).toEqual(createDefaultSketch())
    expect(parseSketch("[]")).toEqual(createDefaultSketch())
    expect(parseSketch("123")).toEqual(createDefaultSketch())
  })

  it("parses and normalizes valid Excalidraw JSON", () => {
    const input = JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "https://excalidraw.com",
      elements: [{ id: "elem-1", type: "rectangle", x: 10, y: 20, width: 100, height: 50 }],
      appState: { viewBackgroundColor: "#000000" },
      files: { "file-1": { mimeType: "image/png" } },
      customMeta: "preserved",
    })

    const parsed = parseSketch(input)
    expect(parsed.type).toBe("excalidraw")
    expect(parsed.elements).toHaveLength(1)
    expect(parsed.elements[0].id).toBe("elem-1")
    expect(parsed.appState.viewBackgroundColor).toBe("#000000")
    expect(parsed.files["file-1"]).toBeDefined()
    expect(parsed.customMeta).toBe("preserved")
  })

  it("validates and serializes cleanly with round-trip preservation", () => {
    const raw = JSON.stringify(
      {
        type: "excalidraw",
        version: 2,
        source: "amby-notes",
        elements: [{ id: "e1", type: "ellipse", x: 5, y: 15 }],
        appState: { viewBackgroundColor: "#fafafa" },
        files: {},
        customProp: 42,
      },
      null,
      2,
    )

    const serialized = validateAndSerializeSketch(raw)
    expect(serialized.endsWith("\n")).toBe(true)
    const reparsed = JSON.parse(serialized)
    expect(reparsed.customProp).toBe(42)
    expect(reparsed.elements[0].type).toBe("ellipse")
    expect(reparsed.appState.viewBackgroundColor).toBe("#fafafa")
  })

  it("rejects invalid or corrupted JSON in validateAndSerializeSketch", () => {
    expect(() => validateAndSerializeSketch("not json")).toThrow("valid JSON")
    expect(() => validateAndSerializeSketch("null")).toThrow("JSON object")
    expect(() => validateAndSerializeSketch("[1, 2, 3]")).toThrow("JSON object")
    expect(() => validateAndSerializeSketch(JSON.stringify({ elements: "not an array" }))).toThrow(
      "elements must be an array",
    )
    expect(() => validateAndSerializeSketch(JSON.stringify({ appState: "not an object" }))).toThrow(
      "appState must be an object",
    )
    expect(() => validateAndSerializeSketch(JSON.stringify({ files: 123 }))).toThrow(
      "files must be an object",
    )
  })

  it("serializes sketch state into string cleanly", () => {
    const serialized = serializeSketch({
      elements: [{ id: "arrow-1", type: "arrow" }],
      appState: { viewBackgroundColor: "#ffffff", collaboratorCount: 0 },
      files: {},
      extra: "ok",
    })
    const parsed = JSON.parse(serialized)
    expect(parsed.type).toBe("excalidraw")
    expect(parsed.elements).toHaveLength(1)
    expect(parsed.extra).toBe("ok")
  })

  it("strips runtime-only and non-serializable fields from appState", () => {
    const serialized = serializeSketch({
      elements: [],
      appState: {
        viewBackgroundColor: "#121212",
        gridSize: 20,
        collaborators: new Map([["socket-1", { username: "Alice" }]]),
        followedBy: new Set(["socket-2"]),
        zoom: { value: 1.5 },
        scrollX: 100,
        scrollY: 200,
        selectionElement: { id: "sel-1" },
        activeTool: { type: "selection" },
        width: 1440,
        height: 900,
        theme: "dark",
        viewModeEnabled: true,
        currentItemStrokeColor: "#1e1e1e",
        currentItemStrokeWidth: 2,
      },
    })
    const parsed = JSON.parse(serialized)
    expect(parsed.appState.viewBackgroundColor).toBe("#121212")
    expect(parsed.appState.gridSize).toBe(20)
    expect(parsed.appState.collaborators).toBeUndefined()
    expect(parsed.appState.followedBy).toBeUndefined()
    expect(parsed.appState.zoom).toBeUndefined()
    expect(parsed.appState.scrollX).toBeUndefined()
    expect(parsed.appState.selectionElement).toBeUndefined()
    expect(parsed.appState.width).toBeUndefined()
    expect(parsed.appState.theme).toBeUndefined()
    expect(parsed.appState.viewModeEnabled).toBeUndefined()
    expect(parsed.appState.currentItemStrokeColor).toBeUndefined()
    expect(parsed.appState.currentItemStrokeWidth).toBeUndefined()
  })

  it("strips collaborators when parsing corrupted input JSON", () => {
    const corruptedInput = JSON.stringify({
      type: "excalidraw",
      version: 2,
      elements: [],
      appState: {
        viewBackgroundColor: "#ffffff",
        collaborators: {},
        zoom: { value: 1 },
      },
      files: {},
    })
    const parsed = parseSketch(corruptedInput)
    expect(parsed.appState.viewBackgroundColor).toBe("#ffffff")
    expect(parsed.appState.collaborators).toBeUndefined()
    expect(parsed.appState.zoom).toBeUndefined()

    const revalidated = validateAndSerializeSketch(corruptedInput)
    const reparsed = JSON.parse(revalidated)
    expect(reparsed.appState.collaborators).toBeUndefined()
  })
})
