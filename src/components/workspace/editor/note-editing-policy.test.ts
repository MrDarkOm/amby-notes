import { describe, expect, it } from "vitest"
import type { NoteProperties } from "@/lib/storage"
import { inspectMarkdownCompatibility, noteEditingPolicy } from "./note-editing-policy"

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

it("does not mislabel closed malformed YAML as unterminated when Markdown is lossy", () => {
  expect(
    noteEditingPolicy(
      { ...properties, frontmatterStatus: "invalid", bodyReadOnly: false },
      { ok: false },
    ).warningKey,
  ).toBe("workspace.invalidFrontmatter")
})

describe("Live Preview admission for text with a space at the end", () => {
  it("keeps a note open in Live Preview after a word and a space are typed", () => {
    // The Creative note "1 Глава" was a single line, "Начало ".
    for (const body of ["Начало ", "Начало \n", "# T\n\nНачало "]) {
      const compatibility = inspectMarkdownCompatibility(body, body)
      expect(compatibility, JSON.stringify(body)).toEqual({ ok: true })
      expect(noteEditingPolicy(undefined, compatibility).sourceOnly).toBe(false)
    }
  })

  it("opens a note with whitespace-only lines left by an earlier editor in Live Preview", () => {
    const body = "Фев\n\nФлдыовдыф\n\n   \n\n  \n\n     "
    const compatibility = inspectMarkdownCompatibility(body, `---\namby-id: x\n---\n${body}`)
    expect(compatibility).toEqual({ ok: true })
    expect(noteEditingPolicy(undefined, compatibility).sourceOnly).toBe(false)
  })

  it("still opens a note the editor cannot reproduce in Source mode", () => {
    const compatibility = inspectMarkdownCompatibility("a \nb", "a \nb")
    expect(compatibility).toEqual({ ok: false, reason: "round_trip_mismatch" })
    expect(noteEditingPolicy(undefined, compatibility)).toMatchObject({
      sourceOnly: true,
      warningKey: "workspace.losslessSourceOnly",
    })
  })
})
