// @vitest-environment happy-dom
// The toast (docs/notices.md, section 6): only the announcement of danger or a decision about an object that
// is not on the screen. Top right, ten seconds each, paused by the pointer, three at most and "N more".
// It leads to the place; it does not decide anything.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { OPEN_PANEL_REQUEST_EVENT } from "../panel-navigation"
import { OPEN_NOTE_REQUEST_EVENT } from "./note-open-request"
import { NoticeToastHost } from "./notice-toasts-host"
import { useNoticeToastStore, type ToastInput } from "./use-notice-toasts-store"

const conflictToast = (id: string, name = "идея"): ToastInput => ({
  id,
  level: "decision",
  titleKey: "sync.vault.conflicts.editedTitle",
  params: { name },
  actionKey: "notices.toast.open",
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
  it("stands in the top right corner, is read out by its level, and has one button", () => {
    render(<NoticeToastHost />)
    announce(saveToast("b"))
    announce(conflictToast("a"))
    const stack = screen.getByTestId("notice-toasts")
    expect(stack.className).toMatch(/\btop-/)
    expect(stack.className).toMatch(/\bright-/)
    const [danger, decision] = toasts()
    expect(danger!.getAttribute("role")).toBe("alert")
    expect(danger!.getAttribute("data-level")).toBe("danger")
    expect(decision!.getAttribute("role")).toBe("status")
    expect(decision!.getAttribute("data-level")).toBe("decision")
    expect(danger!.textContent).toMatch(/«идея» не сохранилась/)
    // One way to the place and one way to close it; nothing to decide inside.
    expect(within(danger!).getAllByRole("button")).toHaveLength(2)
  })

  it("opens the centre from a toast about the sync, and goes away", () => {
    render(<NoticeToastHost />)
    announce(conflictToast("a"))
    const asked: unknown[] = []
    const listen = (event: Event) => asked.push((event as CustomEvent).detail)
    window.addEventListener(OPEN_PANEL_REQUEST_EVENT, listen)
    fireEvent.click(within(toasts()[0]!).getByRole("button", { name: "Открыть центр уведомлений" }))
    window.removeEventListener(OPEN_PANEL_REQUEST_EVENT, listen)
    expect(asked).toEqual([{ panelId: "notices-centre" }])
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
  })

  it("can be closed without going anywhere", () => {
    render(<NoticeToastHost />)
    announce(conflictToast("a"))
    fireEvent.click(within(toasts()[0]!).getByRole("button", { name: "Закрыть" }))
    expect(toasts()).toHaveLength(0)
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
  it("shows three and folds the rest into 'N more', which leads to the centre", () => {
    render(<NoticeToastHost />)
    for (const id of ["a", "b", "c", "d", "e"]) announce(conflictToast(id))
    expect(toasts()).toHaveLength(3)
    const more = screen.getByTestId("notice-toasts-more")
    expect(more.textContent).toMatch(/ещё 2/)
    const asked: unknown[] = []
    const listen = (event: Event) => asked.push((event as CustomEvent).detail)
    window.addEventListener(OPEN_PANEL_REQUEST_EVENT, listen)
    fireEvent.click(more)
    window.removeEventListener(OPEN_PANEL_REQUEST_EVENT, listen)
    expect(asked).toEqual([{ panelId: "notices-centre" }])
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
