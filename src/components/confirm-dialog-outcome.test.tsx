// @vitest-environment happy-dom
// What closes the window and what it says: the buttons answer "yes" and "no"; Escape and a click beside the
// window close it without an answer (`dismissed`). Only a question asked with `confirmChoice` hears the difference.
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { confirmChoice, useConfirmStore, type ConfirmOutcome } from "@/lib/confirm"
import { ConfirmDialogHost } from "./confirm-dialog-host"

const draft = {
  title: "Восстановить несохранённую версию?",
  description: "Если не восстанавливать, она будет удалена.",
  confirmLabel: "Восстановить",
  cancelLabel: "Не восстанавливать",
}

function ask() {
  const result: { outcome: ConfirmOutcome | null } = { outcome: null }
  let promise!: Promise<ConfirmOutcome>
  act(() => {
    promise = confirmChoice(draft)
  })
  void promise.then((value) => (result.outcome = value))
  return result
}
const tick = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 30)))

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  useConfirmStore.setState(useConfirmStore.getInitialState())
})
afterEach(cleanup)

describe("the outcomes of the window", () => {
  it("the action button is yes", async () => {
    render(<ConfirmDialogHost />)
    const result = ask()
    fireEvent.click(screen.getByRole("button", { name: "Восстановить" }))
    await tick()
    expect(result.outcome).toBe("yes")
  })

  it("the button with its own word ('Do not restore') is no", async () => {
    render(<ConfirmDialogHost />)
    const result = ask()
    fireEvent.click(screen.getByRole("button", { name: "Не восстанавливать" }))
    await tick()
    expect(result.outcome).toBe("no")
  })

  it("Escape closes the window without an answer", async () => {
    render(<ConfirmDialogHost />)
    const result = ask()
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" })
    await tick()
    expect(result.outcome).toBe("dismissed")
  })

  it("a click beside the window closes it without an answer", async () => {
    render(<ConfirmDialogHost />)
    const result = ask()
    await tick()
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }))
    await tick()
    expect(result.outcome).toBe("dismissed")
  })
})
