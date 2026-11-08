// @vitest-environment happy-dom
// The toast (docs/notices.md, section 6): only the announcement of danger or a decision about an object that
// is not on the screen. It stands by the bell, the same card as in the stack of the centre, ten seconds
// each, paused by the pointer, three at most and "N more". A click on it opens the stack; there are no
// toasts while the stack is open. It leads to the place; it does not decide anything.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { OPEN_NOTE_REQUEST_EVENT } from "./note-open-request"
import { NoticeToastHost } from "./notice-toasts-host"
import { useNoticeToastStore, type ToastInput } from "./use-notice-toasts-store"
import { useNoticesStackStore } from "./use-notices-stack-store"

const conflictToast = (id: string, name = "идея"): ToastInput => ({
  id,
  level: "decision",
  titleKey: "sync.vault.conflicts.editedTitle",
  params: { name },
  target: { kind: "centre" },
})

const saveToast = (id: string): ToastInput => ({
  id,
  level: "danger",
  titleKey: "notices.centre.closedSaveFailed",
  params: { name: "идея" },
  actionKey: "notices.toast.openNote",
  target: { kind: "note", id: "note-1" },
})

const toasts = () => screen.queryAllByTestId("notice-toast")
const announce = (input: ToastInput) => act(() => useNoticeToastStore.getState().announce(input))
const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms))

beforeEach(async () => {
  vi.useFakeTimers()
  await i18n.changeLanguage("ru")
  useNoticeToastStore.setState(useNoticeToastStore.getInitialState())
  useNoticesStackStore.setState(useNoticesStackStore.getInitialState())
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("what may be announced", () => {
  it("is danger and a decision", () => {
    render(<NoticeToastHost />)
    announce(conflictToast("a"))
    announce(saveToast("b"))
    expect(toasts()).toHaveLength(2)
  })

  it.each(["warning", "info", "success"])(
    "is never %s: it appears in its own place, quietly",
    (level) => {
      render(<NoticeToastHost />)
      announce({ ...conflictToast("a"), level } as unknown as ToastInput)
      expect(toasts()).toHaveLength(0)
      expect(useNoticeToastStore.getState().toasts).toEqual([])
    },
  )

  it("is one toast for one cause, with a number when the cause repeats", () => {
    render(<NoticeToastHost />)
    announce(conflictToast("a"))
    announce(conflictToast("a"))
    expect(toasts()).toHaveLength(1)
    expect(useNoticeToastStore.getState().toasts[0]!.count).toBe(2)
  })
})

describe("how a toast looks and where it leads", () => {
  it("stands by the bell and grows upwards from it, is read out by its level, and decides nothing", () => {
    render(<NoticeToastHost />)
    announce(saveToast("b"))
    announce(conflictToast("a"))
    const stack = screen.getByTestId("notice-toasts")
    expect(stack.style.bottom).not.toBe("")
    expect(stack.style.top).toBe("")
    expect(stack.style.left !== "" || stack.style.right !== "").toBe(true)
    const [danger, decision] = toasts()
    expect(danger!.getAttribute("role")).toBe("alert")
    expect(danger!.getAttribute("data-level")).toBe("danger")
    expect(decision!.getAttribute("role")).toBe("status")
    expect(decision!.getAttribute("data-level")).toBe("decision")
    expect(danger!.textContent).toMatch(/Заметка «идея» не сохранилась/)
    // A toast about a note has one short button to it and a way to close; one about the sync has only the way to close.
    expect(
      within(danger!)
        .getAllByRole("button")
        .map((b) => b.textContent || b.getAttribute("aria-label")),
    ).toEqual(["Открыть", "Закрыть"])
    expect(
      within(decision!)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Закрыть"])
  })

  it("is the same calm card as in the stack: no fill, a stripe and the icon of the level", () => {
    render(<NoticeToastHost />)
    announce(saveToast("b"))
    announce(conflictToast("a"))
    for (const toast of toasts()) {
      const level = toast.getAttribute("data-level")!
      const classes = toast.getAttribute("class") ?? ""
      expect(classes).not.toMatch(/--notice-[a-z]+-bg/)
      expect(classes).not.toMatch(/--notice-[a-z]+-border/)
      expect(classes).toContain("border-l-[color:" + "var(--notice-" + level + "-fg)]")
      expect(toast.querySelector("svg")?.getAttribute("class") ?? "").toContain(
        `--notice-${level}-fg`,
      )
    }
  })

  it("opens the stack when it is clicked, and goes into it", () => {
    render(<NoticeToastHost />)
    announce(conflictToast("a"))
    fireEvent.click(toasts()[0]!)
    expect(useNoticesStackStore.getState().isOpen).toBe(true)
    expect(toasts()).toHaveLength(0)
  })

  it("opens the note from a toast about a note", () => {
    render(<NoticeToastHost />)
    announce(saveToast("b"))
    const asked: unknown[] = []
    const listen = (event: Event) => asked.push((event as CustomEvent).detail)
    window.addEventListener(OPEN_NOTE_REQUEST_EVENT, listen)
    fireEvent.click(within(toasts()[0]!).getByRole("button", { name: "Открыть" }))
    window.removeEventListener(OPEN_NOTE_REQUEST_EVENT, listen)
    expect(asked).toEqual([{ id: "note-1" }])
    expect(toasts()).toHaveLength(0)
    // The button goes to the note; it does not also open the stack.
    expect(useNoticesStackStore.getState().isOpen).toBe(false)
  })

  it("can be closed without going anywhere", () => {
    render(<NoticeToastHost />)
    announce(conflictToast("a"))
    fireEvent.click(within(toasts()[0]!).getByRole("button", { name: "Закрыть" }))
    expect(toasts()).toHaveLength(0)
  })
})

describe("a toast and the stack of the centre", () => {
  it("is not shown while the stack is open: the place of the notice is seen already", () => {
    render(<NoticeToastHost />)
    act(() => useNoticesStackStore.getState().open())
    announce(conflictToast("a"))
    expect(toasts()).toHaveLength(0)
    expect(useNoticeToastStore.getState().toasts).toEqual([])
  })

  it("that is hanging when the stack is opened goes into the stack", () => {
    render(<NoticeToastHost />)
    announce(conflictToast("a"))
    announce(saveToast("b"))
    expect(toasts()).toHaveLength(2)
    act(() => useNoticesStackStore.getState().open())
    expect(toasts()).toHaveLength(0)
    expect(useNoticeToastStore.getState().toasts).toEqual([])
  })

  it("is announced again as usual once the stack is closed", () => {
    render(<NoticeToastHost />)
    act(() => useNoticesStackStore.getState().open())
    act(() => useNoticesStackStore.getState().close())
    announce(conflictToast("a"))
    expect(toasts()).toHaveLength(1)
  })

  it("stands on the side of the dock, like the stack, 12px from the edge of the dock, and does not cover its buttons", () => {
    const box = (left: number, width: number, top: number, bottom: number) =>
      ({
        left,
        right: left + width,
        top,
        bottom,
        width,
        height: bottom - top,
        x: left,
        y: top,
      }) as DOMRect
    const dock = document.createElement("div")
    dock.setAttribute("data-activity-bar", "left")
    dock.getBoundingClientRect = () => box(0, 48, 0, 768)
    const bell = document.createElement("button")
    bell.setAttribute("data-activity-button", "notices")
    bell.getBoundingClientRect = () => box(4, 36, 500, 530)
    dock.append(bell)
    document.body.append(dock)
    render(<NoticeToastHost />)
    announce(conflictToast("a"))
    const stack = screen.getByTestId("notice-toasts")
    expect(stack.style.left).toBe("60px")
    expect(Number.parseInt(stack.style.bottom)).toBeGreaterThanOrEqual(window.innerHeight - 530)
    dock.remove()
  })

  it("keeps the same gap on the right side when the dock is there", () => {
    const box = (left: number, width: number, top: number, bottom: number) =>
      ({
        left,
        right: left + width,
        top,
        bottom,
        width,
        height: bottom - top,
        x: left,
        y: top,
      }) as DOMRect
    const edge = window.innerWidth - 48
    const dock = document.createElement("div")
    dock.setAttribute("data-activity-bar", "right")
    dock.getBoundingClientRect = () => box(edge, 48, 0, 768)
    const bell = document.createElement("button")
    bell.setAttribute("data-activity-button", "notices")
    bell.getBoundingClientRect = () => box(edge + 8, 36, 500, 530)
    dock.append(bell)
    document.body.append(dock)
    render(<NoticeToastHost />)
    announce(conflictToast("a"))
    const stack = screen.getByTestId("notice-toasts")
    expect(stack.style.right).toBe("60px")
    expect(stack.style.left).toBe("")
    dock.remove()
  })

  it("keeps the 'N more' chip in the same column, inside the gap", () => {
    render(<NoticeToastHost />)
    for (const id of ["a", "b", "c", "d"]) announce(conflictToast(id))
    const stack = screen.getByTestId("notice-toasts")
    expect(stack.contains(screen.getByTestId("notice-toasts-more"))).toBe(true)
  })
})

describe("how long a toast stays", () => {
  it("goes after ten seconds", () => {
    render(<NoticeToastHost />)
    announce(conflictToast("a"))
    tick(9_900)
    expect(toasts()).toHaveLength(1)
    tick(200)
    expect(toasts()).toHaveLength(0)
  })

  it("stops the time while the pointer is over it, and goes on with what was left", () => {
    render(<NoticeToastHost />)
    announce(conflictToast("a"))
    tick(6_000)
    fireEvent.mouseEnter(toasts()[0]!)
    tick(60_000)
    expect(toasts()).toHaveLength(1)
    fireEvent.mouseLeave(toasts()[0]!)
    tick(3_900)
    expect(toasts()).toHaveLength(1)
    tick(200)
    expect(toasts()).toHaveLength(0)
  })

  it("gives each toast its own time", () => {
    render(<NoticeToastHost />)
    announce(conflictToast("a"))
    tick(5_000)
    announce(conflictToast("b"))
    tick(5_100)
    expect(toasts().map((toast) => toast.getAttribute("data-toast-id"))).toEqual(["b"])
    tick(5_000)
    expect(toasts()).toHaveLength(0)
  })

  it("starts anew when the same cause is announced again", () => {
    render(<NoticeToastHost />)
    announce(conflictToast("a"))
    tick(8_000)
    announce(conflictToast("a"))
    tick(8_000)
    expect(toasts()).toHaveLength(1)
  })
})

describe("how many are seen", () => {
  it("shows three and folds the rest into 'N more', which opens the stack", () => {
    render(<NoticeToastHost />)
    for (const id of ["a", "b", "c", "d", "e"]) announce(conflictToast(id))
    expect(toasts()).toHaveLength(3)
    const more = screen.getByTestId("notice-toasts-more")
    expect(more.textContent).toMatch(/ещё 2/)
    fireEvent.click(more)
    expect(useNoticesStackStore.getState().isOpen).toBe(true)
    expect(toasts()).toHaveLength(0)
  })

  it("shows the next one when a place is free, with a time of its own", () => {
    render(<NoticeToastHost />)
    for (const id of ["a", "b", "c"]) announce(conflictToast(id))
    tick(5_000)
    announce(conflictToast("d"))
    expect(screen.getByTestId("notice-toasts-more").textContent).toMatch(/ещё 1/)
    tick(5_100)
    // a, b and c are gone; d is shown now and has its whole ten seconds.
    expect(toasts().map((toast) => toast.getAttribute("data-toast-id"))).toEqual(["d"])
    expect(screen.queryByTestId("notice-toasts-more")).toBeNull()
    tick(9_800)
    expect(toasts()).toHaveLength(1)
    tick(300)
    expect(toasts()).toHaveLength(0)
  })

  it("has the sentence for any number in both languages", async () => {
    render(<NoticeToastHost />)
    for (const id of ["a", "b", "c", "d", "e", "f", "g"]) announce(conflictToast(id))
    expect(screen.getByTestId("notice-toasts-more").textContent).toMatch(/ещё 4/)
    await act(async () => {
      await i18n.changeLanguage("en")
    })
    expect(screen.getByTestId("notice-toasts-more").textContent).toMatch(/4 more/)
  })
})
