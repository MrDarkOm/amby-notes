// @vitest-environment happy-dom
import * as React from "react"
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"

// The root passes new props to its layout on every one of its own renders, so a layout render
// counts a root render.
const renders = vi.hoisted(() => ({ layout: 0 }))
vi.mock("./workspace-normal-layout", async (importOriginal) => {
  const original = await importOriginal<typeof import("./workspace-normal-layout")>()
  return {
    ...original,
    WorkspaceNormalLayout: (props: React.ComponentProps<typeof original.WorkspaceNormalLayout>) => {
      renders.layout += 1
      return original.WorkspaceNormalLayout(props)
    },
  }
})
import { WorkspaceOrchestration } from "../workspace-orchestration"

// Role queries are very slow on the whole shell in happy-dom; plain selectors are enough here.
const dialog = () => document.querySelector('[role="dialog"]')

// happy-dom reports a non-Mac platform, so "Mod" is Ctrl.
function pressMod(key: string, code: string, shiftKey = false) {
  act(() => {
    fireEvent.keyDown(window, { key, code, ctrlKey: true, shiftKey })
  })
}

describe("workspace overlays", () => {
  beforeEach(() => {
    localStorage.clear()
    renders.layout = 0
  })
  afterEach(cleanup)

  it("opens and closes quick open and search from their shortcuts", async () => {
    render(<WorkspaceOrchestration />)
    expect(dialog()).toBeNull()
    pressMod("p", "KeyP")
    await waitFor(() => expect(dialog()).not.toBeNull())
    act(() => {
      fireEvent.keyDown(dialog() as Element, { key: "Escape", code: "Escape" })
    })
    await waitFor(() => expect(dialog()).toBeNull())
    pressMod("f", "KeyF", true)
    await waitFor(() => expect(dialog()).not.toBeNull())
  })

  it("opens settings from its shortcut", async () => {
    render(<WorkspaceOrchestration />)
    pressMod(",", "Comma")
    await waitFor(() => expect(document.querySelector('[role="tab"]')).not.toBeNull())
    expect(dialog()).not.toBeNull()
  })

  // SHELL-04: the open flags live in a small store, so opening an overlay renders the overlay
  // and nothing above it.
  it("does not re-render the shell when an overlay opens or closes", async () => {
    render(<WorkspaceOrchestration />)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    const before = renders.layout
    pressMod("f", "KeyF", true)
    await waitFor(() => expect(dialog()).not.toBeNull())
    act(() => {
      fireEvent.keyDown(dialog() as Element, { key: "Escape", code: "Escape" })
    })
    await waitFor(() => expect(dialog()).toBeNull())
    pressMod("p", "KeyP")
    await waitFor(() => expect(dialog()).not.toBeNull())
    expect(renders.layout).toBe(before)
  })
})
