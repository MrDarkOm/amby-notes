import { describe, expect, it, vi } from "vitest"
import { loadNoteLayerContent } from "./use-layers"
import * as storage from "@/lib/storage"

describe("loadNoteLayerContent", () => {
  it("strips amby-id frontmatter from content and preserves source", async () => {
    const rawNote = "---\namby-id: 01M2G6775PZPKWZ4CFKBAV0AA\n---\n"
    vi.spyOn(storage, "readFile").mockResolvedValue(rawNote)

    const result = await loadNoteLayerContent("/vault/Tasks/Tasks.md")

    expect(result.content).toBe("")
    expect(result.source).toBe(rawNote)
    expect(result.noteId).toBe("01M2G6775PZPKWZ4CFKBAV0AA")
    expect(result.revision).toBeDefined()
  })

  it("extracts noteId and body text when note has content", async () => {
    const rawNote = "---\namby-id: 01M2G6775PZPKWZ4CFKBAV0AA\n---\n# Tasks\n\n- Task 1"
    vi.spyOn(storage, "readFile").mockResolvedValue(rawNote)

    const result = await loadNoteLayerContent("/vault/Tasks/Tasks.md")

    expect(result.content).toBe("# Tasks\n\n- Task 1")
    expect(result.source).toBe(rawNote)
    expect(result.noteId).toBe("01M2G6775PZPKWZ4CFKBAV0AA")
  })
})
