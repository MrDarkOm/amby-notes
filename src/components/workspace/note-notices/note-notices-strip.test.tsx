// @vitest-environment happy-dom
// The strip of a note's notices (docs/notices.md, section 7) is a small pill: the icon of the most serious
// level, its card's title in one line, "+N" for the others and a chevron. Open, it is a rounded panel with
// a header row and the cards. The level is the
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
    expect(within(strip()).queryByTestId("note-notices-dot")).toBeNull()
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

  it("opens a panel with a header row first and every card below it", () => {
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
      "note-notices-strip",
      "note-notices-stack",
    ])
    // the header and the cards are one rounded panel: popover surface, a border and a soft shadow
    const frame = screen.getByTestId("note-notices-frame")
    expect(frame.contains(strip())).toBe(true)
    expect(frame.contains(panel)).toBe(true)
    const classes = frame.getAttribute("class") ?? ""
    expect(classes).toMatch(/rounded-xl/)
    expect(classes).toMatch(/bg-popover/)
    expect(classes).toMatch(/shadow-/)
    expect(classes).not.toMatch(/rounded-t-xl|border-b-0/)
  })

  it("says what the panel is in its header: the note's notices and how many", () => {
    saveFailed()
    restored()
    mount()
    expect(strip().textContent).toContain("Уведомления заметки · 2")
    expect(strip().querySelector("svg.lucide-chevron-down")).not.toBeNull()
    expect(strip().getAttribute("aria-label")).toBe("Уведомления заметки: 2")
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

  it("does not float over the note by itself: the bar of the note places it and covers its foot", () => {
    restored()
    mount()
    const root = screen.getByTestId("note-notices")
    const classes = root.getAttribute("class") ?? ""
    // no stacking of its own: it follows the anchor of the floating bar, which is under the bar itself
    expect(classes).not.toMatch(/\bz-\d|z-\[/)
    expect(classes).toContain("inset-x-0")
  })
})

describe("the shape of the strip", () => {
  const frame = () => screen.getByTestId("note-notices-frame")

  it("is a small pill folded: as wide as its content, capped, not as wide as the bar", () => {
    saveFailed()
    mount()
    fireEvent.click(strip()) // fold it: a danger opened it by itself
    const classes = frame().getAttribute("class") ?? ""
    expect(classes).toMatch(/w-fit|w-auto/)
    expect(classes).toMatch(/max-w-\[/)
    expect(classes).toMatch(/rounded-full/)
    expect(classes).not.toMatch(/min-w-\[/)
    expect(classes).not.toMatch(/w-\[calc\(100%/)
    // its own element, not tucked under the bar, with a clear gap above it, at the right edge of the bar
    const root = screen.getByTestId("note-notices")
    const rootClasses = root.getAttribute("class") ?? ""
    expect(rootClasses).toMatch(/bottom-2/)
    expect(rootClasses).not.toMatch(/bottom-\[-/)
    expect(rootClasses).toContain("justify-end")
    expect(classes).not.toMatch(/\bmx-/)
    expect(classes).toMatch(/shrink-0/)
  })

  it("truncates a long title in the pill", () => {
    saveFailed()
    mount()
    fireEvent.click(strip())
    expect(within(strip()).getByText("Не удалось сохранить заметку").getAttribute("class")).toMatch(
      /truncate/,
    )
  })

  it("is about 24rem wide open and never past the screen", () => {
    saveFailed()
    mount()
    expect(frame().getAttribute("class")).toMatch(/w-\[min\(24rem,calc\(100vw-/)
    expect(frame().getAttribute("class")).toMatch(/rounded-xl/)
  })

  it("lets the long text of a card wrap instead of cutting it", () => {
    saveFailed()
    mount()
    const card = screen.getByTestId("note-notice-save-failed")
    expect(card.querySelector("p")!.getAttribute("class")).not.toMatch(/truncate/)
  })
})

describe("the order of the cards in the panel", () => {
  const order = () =>
    within(screen.getByTestId("note-notices-stack"))
      .getAllByTestId(/^note-notice-/)
      .map((element) => element.getAttribute("data-testid"))

  it("goes by seriousness: danger, decision, warning, information", () => {
    restored()
    conflicted()
    saveFailed()
    mount({ warningKey: "workspace.invalidFrontmatter" })
    expect(order()).toEqual([
      "note-notice-save-failed",
      "note-notice-sync-conflict",
      "note-notice-warning",
      "note-notice-restored",
    ])
  })

  it("keeps the old order inside one level", () => {
    conflicted()
    useNoteNoticesStore.getState().offerDraft(ABSOLUTE, { accept: vi.fn(), reject: vi.fn() })
    saveFailed()
    useNoteNoticesStore.getState().setPropertyFailed(ABSOLUTE, true)
    mount()
    expect(order()).toEqual([
      "note-notice-save-failed",
      "note-notice-property-failed",
      "note-notice-sync-conflict",
      "note-notice-draft",
    ])
  })

  it("puts the line of the strip on the most serious card, which is the first of the panel", () => {
    restored()
    conflicted()
    saveFailed()
    mount()
    expect(strip().textContent).toContain("Не удалось сохранить заметку")
    expect(order()[0]).toBe("note-notice-save-failed")
  })
})
