// @vitest-environment happy-dom
import * as React from "react"
import { act, cleanup, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"

// The root passes new props to its layout on every one of its own renders, and a layout without a
// memo barrier renders with it, so a layout render counts the renders of the whole shell.
const renders = vi.hoisted(() => ({ layout: 0 }))
vi.mock("./workspace-normal-layout", async (importOriginal) => {
  const original = await importOriginal<typeof import("./workspace-normal-layout")>()
  const Original = original.WorkspaceNormalLayout as React.ComponentType<
    React.ComponentProps<typeof original.WorkspaceNormalLayout>
  >
  const Counted = (props: React.ComponentProps<typeof original.WorkspaceNormalLayout>) => {
    renders.layout += 1
    return <Original {...props} />
  }
  return { ...original, WorkspaceNormalLayout: Counted }
})
import { WorkspaceOrchestration } from "../workspace-orchestration"
import { useDocStore, type Document } from "../use-doc-store"
import { useTabsStore } from "../use-tabs-store"
import { useVaultStore } from "../use-vault-store"

const FILE_ID = "note-1"

function doc(content: string): Document {
  return {
    id: FILE_ID,
    title: "Note",
    content,
    created: "",
    modified: "",
    wordCount: 0,
    path: "/vault/Note.md",
    source: content,
  }
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150))
  })
}

describe("workspace layout renders", () => {
  beforeEach(() => {
    localStorage.clear()
    renders.layout = 0
  })
  afterEach(() => {
    cleanup()
    useDocStore.getState().clearDocs()
  })

  // SHELL-04: typing changes the open document in the store; the shell around the editor has
  // nothing to show for it.
  it("does not render the layout when the text of the open note changes", async () => {
    useVaultStore.setState({ vault: "/vault", startupResolved: true })
    useDocStore.getState().setDoc(FILE_ID, doc("a"))
    useTabsStore.getState().openItem({ kind: "document", fileId: FILE_ID, title: "Note" })
    render(<WorkspaceOrchestration />)
    await waitFor(() => expect(renders.layout).toBeGreaterThan(0))
    await settle()
    const before = renders.layout
    for (const content of ["ab", "abc", "abcd"]) {
      act(() => useDocStore.getState().patchDoc(FILE_ID, { content }))
    }
    await settle()
    expect(renders.layout).toBe(before)
  })

  // The first keystroke marks the note unsaved and the autosave clears it again. Only the tab
  // mark shows it, so nothing but the tab strip has a reason to render.
  it("shows the unsaved mark on the tab without rendering the layout", async () => {
    useVaultStore.setState({ vault: "/vault", startupResolved: true })
    useDocStore.getState().setDoc(FILE_ID, doc("a"))
    useTabsStore.getState().openItem({ kind: "document", fileId: FILE_ID, title: "Note" })
    render(<WorkspaceOrchestration />)
    await waitFor(() => expect(renders.layout).toBeGreaterThan(0))
    await settle()
    const mark = () => document.querySelector("span.size-1\\.5.rounded-full.bg-muted-foreground")
    expect(mark()).toBeNull()
    const before = renders.layout
    act(() => useDocStore.getState().markUnsaved(FILE_ID))
    await waitFor(() => expect(mark()).not.toBeNull())
    act(() => useDocStore.getState().markSaved(FILE_ID))
    await waitFor(() => expect(mark()).toBeNull())
    expect(renders.layout).toBe(before)
  })
})
