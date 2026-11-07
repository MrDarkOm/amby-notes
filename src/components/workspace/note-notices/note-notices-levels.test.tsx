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
    fireEvent.click(screen.getByTestId("note-notices-bulb"))
  }
  return screen.getByTestId(testId)
}

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  useVaultStore.setState({ vault: "/vault" })
  useDocStore.setState({ openDocs: {}, externalConflicts: {}, activeConflictDialogFileId: null })
  useSyncNoticesStore.setState(useSyncNoticesStore.getInitialState())
  useNoteNoticesStore.setState(useNoteNoticesStore.getInitialState())
  vi.mocked(listTrash).mockResolvedValue([])
  vi.mocked(restoreTrash).mockResolvedValue({ changed: [] } as never)
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
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
    ["workspace.identityReadOnly"],
    ["workspace.losslessSourceOnly"],
    ["workspace.invalidFrontmatter"],
    ["workspace.unterminatedFrontmatter"],
  ])("the warning %s about the header is a warning", (key) => {
    mount({ warningKey: key })
    expect(card("note-notice-warning").getAttribute("data-level")).toBe("warning")
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

describe("what each card does as before (behaviour is not part of this step)", () => {
  it("the flag that opens the stack by itself does not follow the level", () => {
    // Three warnings about the header open the stack although they are warnings; the lossless one waits.
    mount({ warningKey: "workspace.invalidFrontmatter" })
    expect(screen.queryByTestId("note-notices-stack")).not.toBeNull()
    expect(screen.getByTestId("note-notice-warning").getAttribute("data-urgent")).toBe("true")
    cleanup()
    mount({ warningKey: "workspace.losslessSourceOnly" })
    expect(screen.queryByTestId("note-notices-stack")).toBeNull()
    cleanup()
    act(() => useNoteNoticesStore.getState().markRestored(ORIGINAL))
    mount()
    expect(screen.queryByTestId("note-notices-stack")).toBeNull()
    expect(card("note-notice-restored").getAttribute("data-urgent")).toBe("false")
  })
})
