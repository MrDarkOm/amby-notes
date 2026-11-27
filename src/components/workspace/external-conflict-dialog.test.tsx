// @vitest-environment happy-dom
// Accepting the external version resolves the conflict, so the recovery draft of the dirty local
// text must go with it: otherwise the next open offers that discarded text again.
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"

const discardRecoveryDraft = vi.fn(async (_id: string, _scope?: unknown) => {})
vi.mock("@/lib/recovery-drafts", () => ({
  discardRecoveryDraft: (id: string, scope?: unknown) => discardRecoveryDraft(id, scope),
}))

import { ExternalConflictDialog } from "./external-conflict-dialog"
import { useDocStore } from "./use-doc-store"
import { useVaultStore } from "./use-vault-store"

describe("accepting the external version", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en")
    discardRecoveryDraft.mockClear()
    useVaultStore.setState({ vault: "/v", backendGeneration: 3 } as never)
    useDocStore.getState().setDoc("n1", {
      id: "n1",
      title: "Note",
      content: "local",
      created: "",
      modified: "",
      wordCount: 1,
      path: "/v/Note.md",
      source: "local",
      noteId: "n1",
    })
    useDocStore.getState().markUnsaved("n1")
    useDocStore.getState().setExternalConflict({
      fileId: "n1",
      path: "/v/Note.md",
      localContent: "local",
      externalContent: "external",
      externalRevision: "r2",
    })
  })
  afterEach(() => {
    cleanup()
    useDocStore.getState().clearDocs()
  })

  it("discards the recovery draft of the note under its id and its path", () => {
    render(<ExternalConflictDialog />)
    fireEvent.click(screen.getByRole("button", { name: "Load text from disk" }))
    expect(useDocStore.getState().openDocs.n1.content).toBe("external")
    const scope = { vault: "/v", generation: 3 }
    expect(discardRecoveryDraft).toHaveBeenCalledWith("n1", scope)
    expect(discardRecoveryDraft).toHaveBeenCalledWith("/v/Note.md", scope)
  })
})
