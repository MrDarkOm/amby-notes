// @vitest-environment happy-dom
// The bulb of a note takes the colour of the most serious level among its cards (docs/notices.md,
// section 7): danger, then decision, then warning. A note with only information or good news has a
// neutral bulb. The colour comes from the theme tokens, through the shared look of the levels.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
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
const ABSOLUTE = `/vault/${ORIGINAL}`
const conflict = {
  id: "0123456789ab",
  kind: "bothEdited",
  originalPath: ORIGINAL,
  copyPath: "Заметки/идея.0123456789ab-conflict.md",
  createdMs: 1_760_000_000_000,
}

function mount(props: Partial<NoteNoticesProps> = {}) {
  return render(
    <NoteNotices document={{ id: ABSOLUTE, path: ABSOLUTE }} warningKey={null} {...props} />,
  )
}
const bulb = () => screen.getByTestId("note-notices-bulb")

const saveFailed = () => useNoteNoticesStore.getState().setSaveFailed(ABSOLUTE, true)
const conflicted = () => useSyncNoticesStore.setState({ conflicts: [conflict] })
const restored = () => useNoteNoticesStore.getState().markRestored(ORIGINAL)

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

describe("the level of the bulb", () => {
  const cases = [
    { name: "one failed save", level: "danger", setups: [saveFailed], props: {} },
    { name: "a conflict", level: "decision", setups: [conflicted], props: {} },
    {
      name: "a warning about the header",
      level: "warning",
      setups: [],
      props: { warningKey: "workspace.invalidFrontmatter" },
    },
    {
      name: "a danger among a decision and a warning",
      level: "danger",
      setups: [saveFailed, conflicted],
      props: { warningKey: "workspace.invalidFrontmatter" },
    },
    {
      name: "a decision among a warning and information",
      level: "decision",
      setups: [conflicted, restored],
      props: { warningKey: "workspace.invalidFrontmatter" },
    },
    {
      name: "a warning and information",
      level: "warning",
      setups: [restored],
      props: { warningKey: "workspace.losslessSourceOnly" },
    },
  ]

  it.each(cases)("$name: the bulb is $level", ({ setups, props, level }) => {
    for (const setup of setups) setup()
    mount(props as Partial<NoteNoticesProps>)
    expect(bulb().getAttribute("data-level")).toBe(level)
    const classes = bulb().getAttribute("class") ?? ""
    expect(classes).toContain(`--notice-${level}-border`)
    expect(classes).toContain(`--notice-${level}-fg`)
    expect(classes).not.toMatch(/amber/)
  })

  it("is neutral when the note has only information", () => {
    restored()
    mount()
    expect(bulb().getAttribute("data-level")).toBeNull()
    expect(bulb().getAttribute("class") ?? "").not.toContain("--notice-")
    expect(bulb().textContent).toContain("1")
  })

  it("follows the cards as they come and go", () => {
    mount()
    act(() => restored())
    expect(bulb().getAttribute("data-level")).toBeNull()
    act(() => conflicted())
    expect(bulb().getAttribute("data-level")).toBe("decision")
    act(() => saveFailed())
    expect(bulb().getAttribute("data-level")).toBe("danger")
    act(() => useNoteNoticesStore.getState().setSaveFailed(ABSOLUTE, false))
    expect(bulb().getAttribute("data-level")).toBe("decision")
    act(() => useSyncNoticesStore.getState().setConflicts([]))
    expect(bulb().getAttribute("data-level")).toBeNull()
  })

  it("says it is urgent exactly when a danger or a decision is there", () => {
    mount({ warningKey: "workspace.invalidFrontmatter" })
    expect(bulb().getAttribute("data-urgent")).toBe("false")
    act(() => conflicted())
    expect(bulb().getAttribute("data-urgent")).toBe("true")
  })
})
