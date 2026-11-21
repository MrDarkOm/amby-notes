// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import type { ProposalCard } from "@/lib/bindings"
import { ProposalError } from "@/lib/ai"
import { useDocStore } from "../use-doc-store"
import { ProposalCards } from "./proposal-cards"
import { useProposalStore } from "./use-proposal-store"

const action = vi.hoisted(() => vi.fn())
vi.mock("@/lib/ai", () => ({
  aiProposalAction: action,
  ProposalError: class extends Error {
    constructor(readonly code: string) {
      super(code)
    }
  },
}))

const pending: ProposalCard = {
  id: "p1",
  path: "folder/a.md",
  kind: "replace",
  diff: "--- a\n+++ b\n@@ -1 +1 @@\n-old line\n+new line\n",
  diffTruncated: false,
  state: "pending",
}

function show(card: ProposalCard = pending) {
  useProposalStore.getState().add("chat", card, 1)
  return render(<ProposalCards chatId="chat" generation={3} vault="/v" show={(at) => at === 1} />)
}

describe("proposal cards", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en")
    action.mockReset()
    useProposalStore.getState().reset()
    useDocStore.getState().clearDocs()
  })
  afterEach(async () => {
    cleanup()
    await i18n.changeLanguage("ru")
  })

  it("shows the change and writes nothing until Apply is clicked", () => {
    show()
    expect(screen.getByText("folder/a.md")).toBeTruthy()
    expect(screen.getByText("-old line")).toBeTruthy()
    expect(screen.getByText("+new line")).toBeTruthy()
    expect(action).not.toHaveBeenCalled()
  })

  it("applies, then offers Undo, with the unsaved notes passed along", async () => {
    action.mockResolvedValueOnce({ ...pending, state: "applied" })
    show()
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Apply" })))
    expect(action).toHaveBeenCalledWith("apply", 3, "p1", [])
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy()
    action.mockResolvedValueOnce({ ...pending, state: "undone" })
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Undo" })))
    expect(action).toHaveBeenLastCalledWith("undo", 3, "p1", [])
    expect(screen.getByText("Undone.")).toBeTruthy()
  })

  it("rejects without a write", async () => {
    action.mockResolvedValueOnce({ ...pending, state: "rejected" })
    show()
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Reject" })))
    expect(action).toHaveBeenCalledWith("reject", 3, "p1", [])
    expect(screen.getByText("Rejected.")).toBeTruthy()
  })

  it("waits for the save of an open note with unsaved edits", () => {
    useDocStore.getState().setDoc("n", {
      id: "n",
      title: "A",
      content: "x",
      created: "",
      modified: "",
      wordCount: 1,
      path: "/v/folder/a.md",
      source: "x",
    })
    useDocStore.getState().markUnsaved("n")
    show()
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/unsaved edits/)).toBeTruthy()
  })

  it("says an outdated proposal wrote nothing, and maps a failure to a stable message", async () => {
    action.mockRejectedValueOnce(new ProposalError("noteHasUnsavedEdits"))
    show()
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Apply" })))
    expect(screen.getByRole("alert").textContent).toMatch(/Save it first/)
    cleanup()
    useProposalStore.getState().reset()
    show({ ...pending, id: "p2", state: "outdated" })
    expect(screen.getByText(/nothing was written/)).toBeTruthy()
  })

  it("shows a card under the answer it was proposed in and nowhere else", () => {
    useProposalStore.getState().add("chat", pending, 1)
    const other = render(
      <ProposalCards chatId="chat" generation={3} vault="/v" show={(at) => at === 3} />,
    )
    expect(other.container.textContent).toBe("")
    cleanup()
    render(<ProposalCards chatId="chat" generation={3} vault="/v" show={(at) => at === 1} />)
    expect(screen.getByText("folder/a.md")).toBeTruthy()
  })

  it("applies a card made under an automatic mode at once, and a manual one never", async () => {
    action.mockResolvedValue({ ...pending, state: "applied" })
    useProposalStore.getState().add("chat", pending, 1, true)
    render(<ProposalCards chatId="chat" generation={3} vault="/v" show={() => true} />)
    await act(async () => {})
    expect(action).toHaveBeenCalledWith("apply", 3, "p1", [])
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy()
    cleanup()
    action.mockClear()
    useProposalStore.getState().reset()
    useProposalStore.getState().add("chat", pending, 1, false)
    render(<ProposalCards chatId="chat" generation={3} vault="/v" show={() => true} />)
    await act(async () => {})
    expect(action).not.toHaveBeenCalled()
  })

  it("holds an automatic card while its note has unsaved edits, then applies it once saved", async () => {
    action.mockResolvedValue({ ...pending, state: "applied" })
    useDocStore.getState().setDoc("n", {
      id: "n",
      title: "A",
      content: "x",
      created: "",
      modified: "",
      wordCount: 1,
      path: "/v/folder/a.md",
      source: "x",
    })
    useDocStore.getState().markUnsaved("n")
    useProposalStore.getState().add("chat", pending, 1, true)
    render(<ProposalCards chatId="chat" generation={3} vault="/v" show={() => true} />)
    await act(async () => {})
    expect(action).not.toHaveBeenCalled()
    await act(async () => useDocStore.getState().markSaved("n"))
    expect(action).toHaveBeenCalledWith("apply", 3, "p1", [])
  })

  it("keeps the approval mode per chat, manual by default", () => {
    expect(useProposalStore.getState().modes["chat"]).toBeUndefined()
    useProposalStore.getState().setMode("chat", "turbo")
    expect(useProposalStore.getState().modes["chat"]).toBe("turbo")
    expect(useProposalStore.getState().modes["other"]).toBeUndefined()
  })
})

describe("database proposal cards", () => {
  beforeEach(async () => {
    action.mockReset()
    useProposalStore.getState().reset()
    await i18n.changeLanguage("en")
  })
  afterEach(async () => {
    cleanup()
    await i18n.changeLanguage("ru")
  })

  it("names a cell change and a new row, and explains a locked database", async () => {
    const cell: ProposalCard = {
      id: "c1",
      path: "Tasks/First.md",
      kind: "setDatabaseValue",
      diff: "--- a\n+++ a\n@@ database cell @@\n+Done: {}\n",
      diffTruncated: false,
      state: "pending",
    }
    useProposalStore.getState().add("chat", cell, 1)
    useProposalStore.getState().add("chat", { ...cell, id: "r1", kind: "createDatabaseRow" }, 1)
    render(<ProposalCards chatId="chat" generation={3} vault="/v" show={() => true} />)
    expect(screen.getByText("Cell value")).toBeTruthy()
    expect(screen.getByText("New database row")).toBeTruthy()
    action.mockRejectedValueOnce(new ProposalError("locked"))
    await act(async () => fireEvent.click(screen.getAllByRole("button", { name: "Apply" })[0]))
    expect(screen.getByRole("alert").textContent).toMatch(/closed for changes/)
  })
})
