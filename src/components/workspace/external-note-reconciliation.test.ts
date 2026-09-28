import { describe, expect, it } from "vitest"
import { isUnchangedNoteRevision } from "./external-note-reconciliation"

describe("external note revision reconciliation", () => {
  it("ignores a saved disk revision while the editor contains a newer unsaved draft", () => {
    expect(
      isUnchangedNoteRevision("saved-crlf-revision", "saved-crlf-revision", "saved-crlf-revision"),
    ).toBe(true)
  })

  it("ignores an older disk read when a local save completed before reconciliation", () => {
    expect(isUnchangedNoteRevision("before-save", "after-save", "before-save")).toBe(true)
  })

  it("keeps a real external change visible even while a local save is completing", () => {
    expect(isUnchangedNoteRevision("external-change", "after-save", "before-save")).toBe(false)
  })

  it("does not treat a missing baseline as proof of a local write", () => {
    expect(isUnchangedNoteRevision("disk-revision", undefined, undefined)).toBe(false)
  })
})
