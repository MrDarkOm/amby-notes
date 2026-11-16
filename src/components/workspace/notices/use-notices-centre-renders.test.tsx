// @vitest-environment happy-dom
// SHELL-03: the centre reads the open notes only for what it decides on (id, path, the deleted/archived
// flags), so typing into a note — which republishes `content` and `source` — does not rebuild it.
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"
import "@/lib/i18n"
import { useDocStore, type Document } from "../use-doc-store"
import { useVaultStore } from "../use-vault-store"
import { useNoticesCentre } from "./use-notices-centre"

const doc = (patch: Partial<Document> = {}): Document => ({
  id: "note",
  title: "Note",
  content: "text",
  created: "",
  modified: "",
  wordCount: 1,
  path: "/vault/Note.md",
  source: "text",
  ...patch,
})

beforeEach(() => {
  useVaultStore.setState({ vault: "/vault" })
  useDocStore.setState({ openDocs: { note: doc() }, externalConflicts: {} })
})
afterEach(cleanup)

describe("useNoticesCentre renders", () => {
  it("does not render again when only the text of an open note changes", () => {
    let renders = 0
    renderHook(() => {
      renders += 1
      return useNoticesCentre()
    })
    const before = renders
    act(() => {
      useDocStore.getState().patchDoc("note", { content: "more text", source: "more text" })
    })
    act(() => {
      useDocStore.getState().patchDoc("note", { content: "more text again", wordCount: 3 })
    })
    expect(renders).toBe(before)
  })

  it("still renders when a flag the centre decides on changes", () => {
    let renders = 0
    renderHook(() => {
      renders += 1
      return useNoticesCentre()
    })
    const before = renders
    act(() => {
      useDocStore.getState().patchDoc("note", { externallyDeleted: true })
    })
    expect(renders).toBeGreaterThan(before)
  })
})
