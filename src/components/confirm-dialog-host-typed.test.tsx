// @vitest-environment happy-dom
// Red contract for the shared confirmation host: exact-input questions are still one common host,
// and an aborted question resolves false without disturbing another queued question.
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { confirm, useConfirmStore } from "@/lib/confirm"
import { ConfirmDialogHost } from "./confirm-dialog-host"

const typedQuestion = {
  title: "Удалить «Рабочее хранилище» с сервера?",
  description: "Копия на сервере и её версии будут удалены навсегда. Локальные файлы останутся.",
  confirmLabel: "Удалить с сервера",
  cancelLabel: "Отмена",
  destructive: true,
  requiredText: { value: "Рабочее хранилище", label: "Введите точное название хранилища" },
}

const ordinaryQuestion = {
  title: "Переместить «План»?",
  description: "Ссылки в 3 заметках обновятся.",
  confirmLabel: "Переместить",
}

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

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  useConfirmStore.setState(useConfirmStore.getInitialState())
})

afterEach(cleanup)

describe("required-text confirmation in the shared host", () => {
  it("renders an exact-name field, starts on Cancel, and keeps Delete disabled until exact", async () => {
    render(<ConfirmDialogHost />)
    const result = ask(typedQuestion)
    const box = screen.getByRole("alertdialog", { name: typedQuestion.title })
    const input = screen.getByRole("textbox", { name: typedQuestion.requiredText.label })
    const action = screen.getByRole("button", { name: typedQuestion.confirmLabel })

    expect((input as HTMLInputElement).value).toBe("")
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Отмена" }))
    expect(action.getAttribute("disabled")).not.toBeNull()
    fireEvent.change(input, { target: { value: "Рабочее" } })
    expect(action.getAttribute("disabled")).not.toBeNull()
    fireEvent.click(action)
    expect(result.answer).toBeNull()
    expect(box.isConnected).toBe(true)

    fireEvent.change(input, { target: { value: typedQuestion.requiredText.value } })
    expect(action.getAttribute("disabled")).toBeNull()
    fireEvent.click(action)
    await flush()
    expect(result.answer).toBe(true)
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  it("does not turn Escape into an action even after the exact name was typed", async () => {
    render(<ConfirmDialogHost />)
    const result = ask(typedQuestion)
    const box = screen.getByRole("alertdialog", { name: typedQuestion.title })
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: typedQuestion.requiredText.value },
    })
    fireEvent.keyDown(box, { key: "Escape" })
    await flush()
    expect(result.answer).toBe(false)
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  it("aborts only its own queued exact-name question and resolves it false", async () => {
    render(<ConfirmDialogHost />)
    const controller = new AbortController()
    const first = ask({ ...typedQuestion, signal: controller.signal })
    const second = ask(ordinaryQuestion)
    controller.abort()
    await flush()

    expect(first.answer).toBe(false)
    expect(screen.getByRole("alertdialog", { name: ordinaryQuestion.title })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: ordinaryQuestion.confirmLabel }))
    await flush()
    expect(second.answer).toBe(true)
  })
})
