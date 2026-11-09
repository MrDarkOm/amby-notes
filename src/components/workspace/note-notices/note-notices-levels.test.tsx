// @vitest-environment happy-dom
// Every card of a note has a level of docs/notices.md (section 2.1), and the level alone gives it its
// look (step 1 of the transition): the same amber triangle no longer stands for a conflict, a limit and a
// piece of good news. The behaviour of the stack (what opens it by itself) stays as it was.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { listTrash, restoreTrash } from "@/lib/storage"
import { useDocStore } from "../use-doc-store"
import { useVaultStore } from "../use-vault-store"
import { useSyncNoticesStore } from "../sync/use-sync-notices-store"
import { NoteNotices, type NoteNoticesProps } from "./note-notices"
import { usePropertyMoveRetryStore } from "../file-actions/property-move-retry-store"
import { useNoteNoticesStore } from "./use-note-notices-store"

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  readNote: vi.fn(),
  listTrash: vi.fn(),
  restoreTrash: vi.fn(),
}))

const ORIGINAL = "Заметки/идея.md"
const conflict = {
  id: "0123456789ab",
  kind: "bothEdited",
  originalPath: ORIGINAL,
  copyPath: "Заметки/идея.0123456789ab-conflict.md",
  createdMs: 1_760_000_000_000,
}
const ABSOLUTE = `/vault/${ORIGINAL}`

function mount(props: Partial<NoteNoticesProps> = {}) {
  return render(
    <NoteNotices document={{ id: ABSOLUTE, path: ABSOLUTE }} warningKey={null} {...props} />,
  )
}

/** The stack, opened with a click if the card did not open it by itself. */
function card(testId: string) {
  if (!screen.queryByTestId("note-notices-stack")) {
    fireEvent.click(screen.getByTestId("note-notices-strip"))
  }
  return screen.getByTestId(testId)
}

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  useVaultStore.setState({ vault: "/vault" })
  useDocStore.setState({ openDocs: {}, externalConflicts: {}, activeConflictDialogFileId: null })
  useSyncNoticesStore.setState(useSyncNoticesStore.getInitialState())
  useNoteNoticesStore.setState(useNoteNoticesStore.getInitialState())
  usePropertyMoveRetryStore.getState().clearAll()
  vi.mocked(listTrash).mockResolvedValue([])
  vi.mocked(restoreTrash).mockResolvedValue({ changed: [] } as never)
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("properties that were not carried over to the database", () => {
  it("is a warning card with a button that asks again, for that note only", async () => {
    const retry = vi.fn().mockResolvedValue(undefined)
    act(() => usePropertyMoveRetryStore.getState().set(ABSOLUTE, { name: "идея", retry }))
    mount()
    expect(card("note-notice-properties-to-database").getAttribute("data-level")).toBe("warning")
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Перенести" }))
    })
    expect(retry).toHaveBeenCalledOnce()
  })

  it("is not on another note", () => {
    act(() =>
      usePropertyMoveRetryStore.getState().set("/vault/other.md", { name: "x", retry: vi.fn() }),
    )
    mount()
    expect(screen.queryByTestId("note-notice-properties-to-database")).toBeNull()
  })
})

describe("the level of every card of a note", () => {
  it("a second version from another computer is a decision", () => {
    useSyncNoticesStore.setState({ conflicts: [conflict] })
    mount()
    expect(card("note-notice-sync-conflict").getAttribute("data-level")).toBe("decision")
  })

  it("a note deleted on another computer is a decision", () => {
    act(() => useSyncNoticesStore.getState().markRemoteDeleted(ORIGINAL))
    mount({ document: { id: ABSOLUTE, path: ABSOLUTE, externallyDeleted: true } })
    expect(card("note-notice-remote-deleted").getAttribute("data-level")).toBe("decision")
  })

  it("a file deleted outside Amby is a danger", () => {
    mount({ document: { id: ABSOLUTE, path: ABSOLUTE, externallyDeleted: true } })
    expect(card("note-notice-deleted").getAttribute("data-level")).toBe("danger")
  })

  it("a change outside Amby with unsaved edits is a decision", () => {
    useDocStore.setState({
      externalConflicts: {
        [ABSOLUTE]: {
          fileId: ABSOLUTE,
          path: ABSOLUTE,
          localContent: "a",
          externalContent: "b",
          externalRevision: "r",
          sourceTemplate: "b",
        },
      },
    })
    mount()
    expect(card("note-notice-external-change").getAttribute("data-level")).toBe("decision")
  })

  it("text that could not be saved is a danger", () => {
    mount()
    act(() => useNoteNoticesStore.getState().setSaveFailed(ABSOLUTE, true))
    expect(card("note-notice-save-failed").getAttribute("data-level")).toBe("danger")
  })

  it("a property that could not be saved is a danger", () => {
    mount()
    act(() => useNoteNoticesStore.getState().setPropertyFailed(ABSOLUTE, true))
    expect(card("note-notice-property-failed").getAttribute("data-level")).toBe("danger")
  })

  it("an unsaved draft found after a crash is a decision", () => {
    act(() =>
      useNoteNoticesStore.getState().offerDraft(ABSOLUTE, { accept: vi.fn(), reject: vi.fn() }),
    )
    mount()
    expect(card("note-notice-draft").getAttribute("data-level")).toBe("decision")
  })

  it.each([
    ["workspace.losslessSourceOnly", "warning"],
    ["workspace.invalidFrontmatter", "warning"],
    ["workspace.unterminatedFrontmatter", "warning"],
    // a lost id switches the properties off for good: the person must decide what to do
    ["workspace.identityReadOnly", "decision"],
  ])("the warning %s about the header is a %s", (key, level) => {
    mount({ warningKey: key })
    expect(card("note-notice-warning").getAttribute("data-level")).toBe(level)
  })

  it("a note that came back is information, not a triangle", () => {
    act(() => useNoteNoticesStore.getState().markRestored(ORIGINAL))
    mount()
    const restored = card("note-notice-restored")
    expect(restored.getAttribute("data-level")).toBe("info")
    expect(restored.querySelector("svg.lucide-info")).not.toBeNull()
    expect(restored.querySelector("svg.lucide-triangle-alert")).toBeNull()
  })

  it("every card draws the icon of its level and no amber class", () => {
    useSyncNoticesStore.setState({ conflicts: [conflict] })
    useNoteNoticesStore.getState().markRestored(ORIGINAL)
    mount({
      warningKey: "workspace.losslessSourceOnly",
      document: { id: ABSOLUTE, path: ABSOLUTE, externallyDeleted: true },
    })
    card("note-notice-sync-conflict")
    const icons: Record<string, string> = {
      "note-notice-sync-conflict": "lucide-triangle-alert",
      "note-notice-deleted": "lucide-octagon-alert",
      "note-notice-warning": "lucide-circle-alert",
      "note-notice-restored": "lucide-info",
    }
    for (const [testId, iconClass] of Object.entries(icons)) {
      const element = screen.getByTestId(testId)
      // the icon of the level stands first; a button of the card may carry an icon of its own
      expect(element.querySelector("svg")!.classList.contains(iconClass)).toBe(true)
    }
    expect(screen.getByTestId("note-notices-stack").innerHTML).not.toMatch(/amber/)
  })

  it("danger is said as an alert and the rest as a status", () => {
    useSyncNoticesStore.setState({ conflicts: [conflict] })
    mount({ document: { id: ABSOLUTE, path: ABSOLUTE, externallyDeleted: true } })
    expect(card("note-notice-deleted").getAttribute("role")).toBe("alert")
    expect(card("note-notice-sync-conflict").getAttribute("role")).toBe("status")
  })
})

describe("what opens the stack by itself follows the level (docs/notices.md, 2.1 and 7)", () => {
  /** Mounts one card; returns whether the stack was open without a click and the flag of the card. */
  function opened(setup: () => void, props: Partial<NoteNoticesProps>, testId: string) {
    cleanup()
    useSyncNoticesStore.setState(useSyncNoticesStore.getInitialState())
    useNoteNoticesStore.setState(useNoteNoticesStore.getInitialState())
    setup()
    mount(props)
    const byItself = screen.queryByTestId("note-notices-stack") !== null
    const flag = card(testId).getAttribute("data-urgent")
    const level = card(testId).getAttribute("data-level")
    return { byItself, flag, level }
  }
  const external = {
    [ABSOLUTE]: {
      fileId: ABSOLUTE,
      path: ABSOLUTE,
      localContent: "a",
      externalContent: "b",
      externalRevision: "r",
      sourceTemplate: "b",
    },
  }
  const none = () => {}

  it.each([
    ["a damaged header", { warningKey: "workspace.invalidFrontmatter" }, "note-notice-warning"],
    [
      "an unterminated header",
      { warningKey: "workspace.unterminatedFrontmatter" },
      "note-notice-warning",
    ],
    [
      "a header that is only source",
      { warningKey: "workspace.losslessSourceOnly" },
      "note-notice-warning",
    ],
  ])("%s is a warning: the stack waits for a click", (_name, props, testId) => {
    const result = opened(none, props, testId)
    expect(result).toEqual({ byItself: false, flag: "false", level: "warning" })
  })

  it("a lost id is a decision: the stack opens by itself", () => {
    const result = opened(none, { warningKey: "workspace.identityReadOnly" }, "note-notice-warning")
    expect(result).toEqual({ byItself: true, flag: "true", level: "decision" })
  })

  it("a note that came back waits for a click", () => {
    const result = opened(
      () => useNoteNoticesStore.getState().markRestored(ORIGINAL),
      {},
      "note-notice-restored",
    )
    expect(result).toEqual({ byItself: false, flag: "false", level: "info" })
  })

  it.each([
    [
      "a sync conflict",
      () => useSyncNoticesStore.setState({ conflicts: [conflict] }),
      {},
      "note-notice-sync-conflict",
      "decision",
    ],
    [
      "a note deleted on another computer",
      () => useSyncNoticesStore.getState().markRemoteDeleted(ORIGINAL),
      { document: { id: ABSOLUTE, path: ABSOLUTE, externallyDeleted: true } },
      "note-notice-remote-deleted",
      "decision",
    ],
    [
      "a file deleted outside Amby",
      none,
      { document: { id: ABSOLUTE, path: ABSOLUTE, externallyDeleted: true } },
      "note-notice-deleted",
      "danger",
    ],
    [
      "a change outside Amby",
      () => useDocStore.setState({ externalConflicts: external }),
      {},
      "note-notice-external-change",
      "decision",
    ],
    [
      "text that was not saved",
      () => useNoteNoticesStore.getState().setSaveFailed(ABSOLUTE, true),
      {},
      "note-notice-save-failed",
      "danger",
    ],
    [
      "a property that was not saved",
      () => useNoteNoticesStore.getState().setPropertyFailed(ABSOLUTE, true),
      {},
      "note-notice-property-failed",
      "danger",
    ],
    [
      "a draft",
      () =>
        useNoteNoticesStore.getState().offerDraft(ABSOLUTE, { accept: vi.fn(), reject: vi.fn() }),
      {},
      "note-notice-draft",
      "decision",
    ],
  ])("%s opens the stack by itself", (_name, setup, props, testId, level) => {
    const result = opened(setup, props as Partial<NoteNoticesProps>, testId)
    expect(result).toEqual({ byItself: true, flag: "true", level })
  })

  it("the flag of every card is the level: urgent only for danger and decision", () => {
    useSyncNoticesStore.setState({ conflicts: [conflict] })
    useNoteNoticesStore.getState().markRestored(ORIGINAL)
    mount({
      warningKey: "workspace.invalidFrontmatter",
      document: { id: ABSOLUTE, path: ABSOLUTE, externallyDeleted: true },
    })
    card("note-notice-warning")
    const cards = [...screen.getByTestId("note-notices-stack").querySelectorAll("[data-level]")]
    expect(cards.length).toBeGreaterThanOrEqual(4)
    for (const element of cards) {
      const level = element.getAttribute("data-level")
      expect(element.getAttribute("data-urgent")).toBe(
        String(level === "danger" || level === "decision"),
      )
    }
  })
})
