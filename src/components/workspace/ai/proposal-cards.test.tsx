// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import type { ProposalCard } from "@/lib/bindings"
import { ProposalError } from "@/lib/ai"
import { useDocStore } from "../use-doc-store"
import { ProposalCards } from "./proposal-cards"
import { autoApplies, useProposalStore } from "./use-proposal-store"

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
  affected: [],
  affectedTruncated: false,
  canUndo: true,
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
    // The header names the file as the tree does; the full path is its tooltip.
    expect(screen.getByText("a").getAttribute("title")).toBe("folder/a.md")
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
    expect(screen.getByText("a")).toBeTruthy()
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
      affected: [],
      affectedTruncated: false,
      canUndo: true,
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

  it("says what Undo does for an applied row and cell, not that note text was kept", () => {
    const applied: ProposalCard = {
      id: "c2",
      path: "Shop/Buy/Milk.md",
      kind: "setDatabaseValue",
      diff: "--- a\n+++ a\n@@ database cell @@\n+Shop: Market\n",
      diffTruncated: false,
      affected: [],
      affectedTruncated: false,
      canUndo: true,
      state: "applied",
    }
    useProposalStore.getState().add("chat", applied, 1)
    useProposalStore.getState().add("chat", { ...applied, id: "r2", kind: "createDatabaseRow" }, 1)
    render(<ProposalCards chatId="chat" generation={3} vault="/v" show={() => true} />)
    expect(screen.getByText("Value written. Undo restores the previous one.")).toBeTruthy()
    expect(screen.getByText("Row added. Undo removes it.")).toBeTruthy()
    expect(screen.queryByText(/note history/)).toBeNull()
  })
})

describe("structural proposal cards", () => {
  const move: ProposalCard = {
    id: "m1",
    path: "chosen",
    kind: "move",
    diff: "--- chosen\n+++ target/chosen\n@@ move @@\n-chosen\n+target/chosen\n",
    diffTruncated: false,
    affected: ["chosen", "chosen/a.md", "chosen/sub/pic.png", "other/ref.md", "target/chosen"],
    affectedTruncated: false,
    canUndo: true,
    state: "pending",
  }
  const open = (path: string) => {
    useDocStore.getState().setDoc("n", {
      id: "n",
      title: "N",
      content: "x",
      created: "",
      modified: "",
      wordCount: 1,
      path,
      source: "x",
    })
    useDocStore.getState().markUnsaved("n")
  }

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

  it("names the kind and lists every affected file, links and attachments included", () => {
    useProposalStore.getState().add("chat", move, 1)
    render(<ProposalCards chatId="chat" generation={3} vault="/v" show={() => true} />)
    expect(screen.getByText("Move")).toBeTruthy()
    const list = screen.getByRole("list", { name: "Files this change touches" })
    expect(list.textContent).toContain("chosen/sub/pic.png")
    expect(list.textContent).toContain("other/ref.md")
    expect(list.textContent).toContain("target/chosen")
    expect(action).not.toHaveBeenCalled()
  })

  it("says when the list is cut short", () => {
    useProposalStore.getState().add("chat", { ...move, affectedTruncated: true }, 1)
    render(<ProposalCards chatId="chat" generation={3} vault="/v" show={() => true} />)
    expect(screen.getByText(/more files than are listed/)).toBeTruthy()
  })

  it("names rename, archive and delete, and says a delete goes to the trash", () => {
    for (const kind of ["rename", "archive", "delete"]) {
      useProposalStore.getState().add("chat", { ...move, id: kind, kind }, 1)
    }
    render(<ProposalCards chatId="chat" generation={3} vault="/v" show={() => true} />)
    expect(screen.getByText("Rename")).toBeTruthy()
    expect(screen.getByText("Move to the archive")).toBeTruthy()
    expect(screen.getByText("Delete")).toBeTruthy()
  })

  it("follows the deletion setting: the trash warns and has no Undo, the archive keeps it", async () => {
    action.mockResolvedValue({
      ...move,
      id: "d1",
      kind: "delete",
      state: "applied",
      canUndo: false,
    })
    useProposalStore.getState().add("chat", { ...move, id: "d1", kind: "delete" }, 1)
    render(<ProposalCards chatId="chat" generation={3} vault="/v" show={() => true} />)
    expect(screen.getByText(/restore it by hand from the trash/)).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Apply" })))
    expect(action).toHaveBeenCalledWith("apply", 3, "d1", [], "system")
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull()
    cleanup()
    action.mockClear()
    useProposalStore.getState().add("chat", { ...move, id: "d2", kind: "delete" }, 1)
    render(
      <ProposalCards
        chatId="chat"
        generation={3}
        vault="/v"
        archiveDeletes
        show={(at) => at === 1}
      />,
    )
    expect(screen.getByText(/Undo can bring it back/)).toBeTruthy()
    const applies = screen.getAllByRole("button", { name: "Apply" })
    await act(async () => fireEvent.click(applies[applies.length - 1]))
    expect(action).toHaveBeenCalledWith("apply", 3, "d2", [], "archive")
  })

  it("waits for a note with unsaved edits that is inside the item or would have its links rewritten", async () => {
    open("/v/chosen/sub/deep.md")
    useProposalStore.getState().add("chat", { ...move, id: "inside" }, 1)
    render(<ProposalCards chatId="chat" generation={3} vault="/v" show={() => true} />)
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/unsaved edits/)).toBeTruthy()
    cleanup()
    useDocStore.getState().clearDocs()
    open("/v/other/ref.md")
    render(<ProposalCards chatId="chat" generation={3} vault="/v" show={() => true} />)
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true)
    expect(action).not.toHaveBeenCalled()
  })

  it("applies an unrestricted-mode card at once and keeps Undo", async () => {
    action.mockResolvedValue({ ...move, state: "applied" })
    useProposalStore.getState().add("chat", move, 1, true)
    render(<ProposalCards chatId="chat" generation={3} vault="/v" show={() => true} />)
    await act(async () => {})
    expect(action).toHaveBeenCalledWith("apply", 3, "m1", [])
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy()
    expect(screen.getByText(/Undo puts everything back/)).toBeTruthy()
  })

  it("maps structural failures to stable messages", async () => {
    action.mockRejectedValueOnce(new ProposalError("mutationConflict"))
    useProposalStore.getState().add("chat", move, 1)
    render(<ProposalCards chatId="chat" generation={3} vault="/v" show={() => true} />)
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Apply" })))
    expect(screen.getByRole("alert").textContent).toMatch(/already exists|in the way/)
  })

  it("decides by mode which changes apply at once", () => {
    for (const kind of ["new", "append", "replace", "setProperty", "createDatabaseRow"]) {
      expect(autoApplies("manual", kind)).toBe(false)
      expect(autoApplies("auto", kind)).toBe(true)
      expect(autoApplies("turbo", kind)).toBe(true)
    }
    for (const kind of ["move", "rename", "archive"]) {
      expect(autoApplies("manual", kind)).toBe(false)
      expect(autoApplies("auto", kind)).toBe(false)
      expect(autoApplies("turbo", kind)).toBe(true)
    }
    // A deletion cannot be undone from the card, so it waits in every mode.
    for (const mode of ["manual", "auto", "turbo"] as const)
      expect(autoApplies(mode, "delete")).toBe(false)
  })

  it("warns before a deletion, passes the deletion setting, and offers no Undo after it", async () => {
    const del: ProposalCard = { ...move, id: "d1", kind: "delete" }
    useProposalStore.getState().add("chat", del, 1)
    render(<ProposalCards chatId="chat" generation={3} vault="/v" show={() => true} />)
    expect(screen.getByRole("note").textContent).toMatch(/restore it by hand from the trash/)
    action.mockResolvedValueOnce({ ...del, state: "applied", canUndo: false })
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Apply" })))
    expect(action).toHaveBeenCalledWith("apply", 3, "d1", [], "system")
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull()
    expect(screen.getByText(/restored by hand from the trash/)).toBeTruthy()
  })
})
