// @vitest-environment happy-dom
// The strip of a note's notices (docs/notices.md, section 7) shows the most serious card in one line:
// its level icon, its title, "+N" for the others, a dot of its level and a chevron. The level is the
// most serious one among the cards (danger, decision, warning, info, success); the colours come from the
// theme tokens through the shared look of the levels. The strip opens by itself only for a danger or a
// decision. Behaviour only; how it looks is checked in a browser.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
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
const strip = () => screen.getByTestId("note-notices-strip")
const dot = () => within(strip()).getByTestId("note-notices-dot")

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

describe("the level of the strip", () => {
  const cases = [
    {
      name: "one failed save",
      level: "danger",
      icon: "octagon-alert",
      setups: [saveFailed],
      props: {},
    },
    {
      name: "a conflict",
      level: "decision",
      icon: "triangle-alert",
      setups: [conflicted],
      props: {},
    },
    {
      name: "a warning about the header",
      level: "warning",
      icon: "circle-alert",
      setups: [],
      props: { warningKey: "workspace.invalidFrontmatter" },
    },
    {
      name: "a danger among a decision and a warning",
      level: "danger",
      icon: "octagon-alert",
      setups: [saveFailed, conflicted],
      props: { warningKey: "workspace.invalidFrontmatter" },
    },
    {
      name: "a decision among a warning and information",
      level: "decision",
      icon: "triangle-alert",
      setups: [conflicted, restored],
      props: { warningKey: "workspace.invalidFrontmatter" },
    },
    {
      name: "a warning and information",
      level: "warning",
      icon: "circle-alert",
      setups: [restored],
      props: { warningKey: "workspace.losslessSourceOnly" },
    },
    { name: "only information", level: "info", icon: "info", setups: [restored], props: {} },
  ]

  it.each(cases)("$name: the strip is $level", ({ setups, props, level, icon }) => {
    for (const setup of setups) setup()
    mount(props as Partial<NoteNoticesProps>)
    expect(strip().getAttribute("data-level")).toBe(level)
    // the icon of the level stands first in the line, and the dot has the colour of the level
    expect(strip().querySelector("svg")!.classList.contains(`lucide-${icon}`)).toBe(true)
    expect(strip().querySelector("svg")!.getAttribute("class")).toContain(`--notice-${level}-fg`)
    expect(dot().getAttribute("data-level")).toBe(level)
    expect(dot().getAttribute("class")).toContain(`--notice-${level}-fg`)
    expect(strip().outerHTML).not.toMatch(/amber|bulb/)
  })

  it("shows the title of the most serious card, cut to one line, and +N for the others", () => {
    saveFailed()
    conflicted()
    mount({ warningKey: "workspace.invalidFrontmatter" })
    const text = strip().textContent ?? ""
    expect(text).toContain("Не удалось сохранить заметку")
    expect(text).toContain("+2")
    const title = within(strip()).getByText("Не удалось сохранить заметку")
    expect(title.getAttribute("class")).toMatch(/truncate/)
  })

  it("follows the cards as they come and go", () => {
    mount()
    act(() => restored())
    expect(strip().getAttribute("data-level")).toBe("info")
    act(() => conflicted())
    expect(strip().getAttribute("data-level")).toBe("decision")
    act(() => saveFailed())
    expect(strip().getAttribute("data-level")).toBe("danger")
    act(() => useNoteNoticesStore.getState().setSaveFailed(ABSOLUTE, false))
    expect(strip().getAttribute("data-level")).toBe("decision")
    act(() => useSyncNoticesStore.getState().setConflicts([]))
    expect(strip().getAttribute("data-level")).toBe("info")
  })

  it("says it is urgent exactly when a danger or a decision is there", () => {
    mount({ warningKey: "workspace.invalidFrontmatter" })
    expect(strip().getAttribute("data-urgent")).toBe("false")
    act(() => conflicted())
    expect(strip().getAttribute("data-urgent")).toBe("true")
  })
})

describe("the strip and the panel of cards", () => {
  it("is one button that says whether the panel is open, with a chevron that turns", () => {
    mount({ warningKey: "workspace.invalidFrontmatter" })
    expect(strip().tagName).toBe("BUTTON")
    expect(strip().getAttribute("aria-expanded")).toBe("false")
    expect(strip().querySelector("svg.lucide-chevron-up")).not.toBeNull()
    fireEvent.click(strip())
    expect(strip().getAttribute("aria-expanded")).toBe("true")
    expect(strip().querySelector("svg.lucide-chevron-down")).not.toBeNull()
    expect(strip().querySelector("svg.lucide-chevron-up")).toBeNull()
  })

  it("opens the panel above the strip with every card, and the strip stays at the foot", () => {
    saveFailed()
    restored()
    mount({ warningKey: "workspace.invalidFrontmatter" })
    // a danger opens the panel by itself
    const panel = screen.getByTestId("note-notices-stack")
    expect(within(panel).getAllByTestId(/^note-notice-/)).toHaveLength(3)
    const root = screen.getByTestId("note-notices")
    const parts = [
      ...root.querySelectorAll(
        '[data-testid="note-notices-stack"], [data-testid="note-notices-strip"]',
      ),
    ]
    expect(parts.map((part) => part.getAttribute("data-testid"))).toEqual([
      "note-notices-stack",
      "note-notices-strip",
    ])
  })

  it("keeps the panel closed for a warning and for information, and opens it for a danger or a decision", () => {
    mount({ warningKey: "workspace.invalidFrontmatter" })
    expect(screen.queryByTestId("note-notices-stack")).toBeNull()
    act(() => restored())
    expect(screen.queryByTestId("note-notices-stack")).toBeNull()
    act(() => conflicted())
    expect(screen.queryByTestId("note-notices-stack")).not.toBeNull()
  })

  it("hides the panel on a click and shows it again on the next one", () => {
    conflicted()
    mount()
    expect(screen.queryByTestId("note-notices-stack")).not.toBeNull()
    fireEvent.click(strip())
    expect(screen.queryByTestId("note-notices-stack")).toBeNull()
    fireEvent.click(strip())
    expect(screen.queryByTestId("note-notices-stack")).not.toBeNull()
  })

  it("limits the height of the panel and scrolls inside it", () => {
    conflicted()
    mount()
    const classes = screen.getByTestId("note-notices-stack").outerHTML
    expect(classes).toMatch(/max-h-/)
    expect(classes).toMatch(/overflow-y-auto/)
  })

  it("is not drawn at all while there are no cards", () => {
    mount()
    expect(screen.queryByTestId("note-notices")).toBeNull()
    expect(screen.queryByTestId("note-notices-strip")).toBeNull()
  })

  it("sits behind the bottom bar of the note, narrower than the screen", () => {
    restored()
    mount()
    const root = screen.getByTestId("note-notices")
    // under the floating bar (z-10), not above it
    expect(root.getAttribute("class")).toMatch(/\bz-\[?[0-9]\b|z-0/)
    expect(root.getAttribute("class")).not.toMatch(/z-20/)
  })
})
