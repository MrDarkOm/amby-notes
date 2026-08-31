import { describe, expect, it } from "vitest"
import type { NoteProperties } from "@/lib/storage"
import { noteEditingPolicy } from "./note-editing-policy"

const properties: NoteProperties = {
  hasFrontmatter: true,
  properties: [],
  customProperties: [],
  parseError: "Invalid YAML",
}

describe("note editing with frontmatter diagnostics", () => {
  it("allows body editing when malformed YAML has a safe body boundary", () => {
    expect(
      noteEditingPolicy({ ...properties, frontmatterStatus: "invalid", bodyReadOnly: false }),
    ).toEqual({
      readOnly: false,
      sourceOnly: false,
      warningKey: "workspace.invalidFrontmatter",
    })
  })

  it("keeps an unterminated envelope editable only as complete source", () => {
    expect(
      noteEditingPolicy({ ...properties, frontmatterStatus: "unterminated", bodyReadOnly: false }),
    ).toEqual({
      readOnly: false,
      sourceOnly: true,
      warningKey: "workspace.unterminatedFrontmatter",
    })
  })

  it("does not unlock duplicate IDs or stale keys after YAML repair", () => {
    for (const frontmatterStatus of ["valid", "invalid", "unterminated"] as const) {
      const result = noteEditingPolicy({ ...properties, frontmatterStatus, bodyReadOnly: true })
      expect(result.readOnly).toBe(true)
      expect(result.warningKey).toBe("workspace.identityReadOnly")
    }
    expect(noteEditingPolicy(properties).readOnly).toBe(true)
  })

  it("leaves ordinary notes editable with no warning", () => {
    expect(noteEditingPolicy()).toEqual({ readOnly: false, sourceOnly: false, warningKey: null })
  })
})
