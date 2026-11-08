// @vitest-environment happy-dom
// The window of confirmation (docs/notices.md, section 9): drawn by the application, answers a promise.
// "Cancel", Escape and a click away are all "no"; a dangerous question puts the focus on the safe button.
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { confirm, useConfirmStore } from "@/lib/confirm"
import { ConfirmDialogHost } from "./confirm-dialog-host"

const danger = {
  title: "Удалить «План» навсегда?",
  description: "Заметка не попадёт в архив, вернуть её будет нельзя.",
  confirmLabel: "Удалить",
  destructive: true,
}
const ordinary = {
  title: "Переместить «План»?",
  description: "Ссылки в 3 заметках обновятся.",
  confirmLabel: "Переместить",
}

/** Asks and keeps the answer, so a test can read it after the click. */
function ask(options: Parameters<typeof confirm>[0]) {
  const result: { answer: boolean | null } = { answer: null }
  let promise!: Promise<boolean>
  act(() => {
    promise = confirm(options)
  })
  void promise.then((value) => (result.answer = value))
  return result
}
const flush = () => act(async () => void (await Promise.resolve()))
const dialog = () => screen.queryByRole("alertdialog")

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  useConfirmStore.setState(useConfirmStore.getInitialState())
})
afterEach(cleanup)

describe("the window", () => {
  it("is not there until something is asked", () => {
    render(<ConfirmDialogHost />)
    expect(dialog()).toBeNull()
  })

  it("shows the question: a title, one line about the data, a verb and Cancel", () => {
    render(<ConfirmDialogHost />)
    ask(danger)
    const box = screen.getByRole("alertdialog", { name: danger.title })
    expect(box.textContent).toContain(danger.description)
    expect(screen.getByRole("button", { name: "Удалить" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Отмена" })).toBeTruthy()
    // It is a question, not a message: nothing to close it by except an answer.
    expect(screen.queryByRole("button", { name: "Закрыть" })).toBeNull()
  })

  it("says yes with the action button, and goes away", async () => {
    render(<ConfirmDialogHost />)
    const result = ask(danger)
    fireEvent.click(screen.getByRole("button", { name: "Удалить" }))
    await flush()
    expect(result.answer).toBe(true)
    expect(dialog()).toBeNull()
  })

  it("says no with Cancel", async () => {
    render(<ConfirmDialogHost />)
    const result = ask(danger)
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }))
    await flush()
    expect(result.answer).toBe(false)
    expect(dialog()).toBeNull()
  })

  it("says no with Escape", async () => {
    render(<ConfirmDialogHost />)
    const result = ask(danger)
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" })
    await flush()
    expect(result.answer).toBe(false)
    expect(dialog()).toBeNull()
  })

  it("says no with a click beside the window", async () => {
    render(<ConfirmDialogHost />)
    const result = ask(danger)
    fireEvent.pointerDown(document.body)
    await flush()
    expect(result.answer).toBe(false)
    expect(dialog()).toBeNull()
  })

  it("asks the next question only after the first is answered", async () => {
    render(<ConfirmDialogHost />)
    const first = ask(danger)
    const second = ask(ordinary)
    expect(screen.getByRole("alertdialog", { name: danger.title })).toBeTruthy()
    expect(screen.queryByText(ordinary.title)).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }))
    await flush()
    expect(first.answer).toBe(false)
    expect(second.answer).toBeNull()
    expect(screen.getByRole("alertdialog", { name: ordinary.title })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Переместить" }))
    await flush()
    expect(second.answer).toBe(true)
  })
})

describe("the look and the focus", () => {
  it("marks a dangerous question as dangerous and an ordinary one as ordinary", () => {
    render(<ConfirmDialogHost />)
    ask(danger)
    expect(screen.getByRole("alertdialog").getAttribute("data-destructive")).toBe("true")
    expect(screen.getByRole("button", { name: "Удалить" }).className).toContain("bg-destructive")
    cleanup()
    useConfirmStore.setState(useConfirmStore.getInitialState())
    render(<ConfirmDialogHost />)
    ask(ordinary)
    expect(screen.getByRole("alertdialog").getAttribute("data-destructive")).toBe("false")
    expect(screen.getByRole("button", { name: "Переместить" }).className).not.toContain(
      "bg-destructive",
    )
  })

  it("puts the focus on the safe button when the action is dangerous", () => {
    render(<ConfirmDialogHost />)
    ask(danger)
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Отмена" }))
  })

  it("puts the focus on the action button when it is an ordinary question", () => {
    render(<ConfirmDialogHost />)
    ask(ordinary)
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Переместить" }))
  })

  it("keeps the focus inside the window: Tab from the last button goes to the first", () => {
    render(<ConfirmDialogHost />)
    ask(danger)
    const cancel = screen.getByRole("button", { name: "Отмена" })
    const action = screen.getByRole("button", { name: "Удалить" })
    const [first, last] = [cancel, action].sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    )
    last.focus()
    fireEvent.keyDown(last, { key: "Tab" })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it("gives the focus back to what had it before", async () => {
    render(
      <>
        <button type="button">Удалить заметку</button>
        <ConfirmDialogHost />
      </>,
    )
    const opener = screen.getByRole("button", { name: "Удалить заметку" })
    opener.focus()
    ask(danger)
    expect(document.activeElement).not.toBe(opener)
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }))
    await flush()
    expect(document.activeElement).toBe(opener)
  })
})

describe("over another window", () => {
  function Underneath({ onClose }: { onClose: () => void }) {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent>
          <DialogTitle>Журнал отладки</DialogTitle>
          <button type="button">Удалить журнал</button>
        </DialogContent>
      </Dialog>
    )
  }

  it("is on top, answers, and leaves the window below open", async () => {
    let closedBelow = 0
    render(
      <>
        <Underneath onClose={() => (closedBelow += 1)} />
        <ConfirmDialogHost />
      </>,
    )
    const result = ask(danger)
    const box = screen.getByRole("alertdialog")
    // The question comes later in the document than the window below, so it is drawn over it.
    const below = screen.getByRole("dialog", { name: "Журнал отладки", hidden: true })
    expect(below.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Удалить" }))
    await flush()
    expect(result.answer).toBe(true)
    expect(screen.getByRole("dialog", { name: "Журнал отладки" })).toBeTruthy()
    expect(closedBelow).toBe(0)
  })

  it("Escape answers only the question, not the window below it", async () => {
    let closedBelow = 0
    render(
      <>
        <Underneath onClose={() => (closedBelow += 1)} />
        <ConfirmDialogHost />
      </>,
    )
    const result = ask(danger)
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" })
    await flush()
    expect(result.answer).toBe(false)
    expect(closedBelow).toBe(0)
    expect(screen.getByRole("dialog", { name: "Журнал отладки" })).toBeTruthy()
  })
})
