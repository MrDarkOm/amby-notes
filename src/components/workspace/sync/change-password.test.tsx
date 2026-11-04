// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { KNOWN_SYNC_ERROR_CODES, syncErrorKey } from "@/lib/sync/sync-errors"
import { SyncPortError } from "@/lib/sync/sync-port"
import { SyncSettings } from "./sync-settings"
import { CONNECTED, createFakePort, type FakePort } from "./fake-sync-port"

const OLD = "Correct-Horse-Battery-Staple-42!"
const STRONG = "A-Brand-New-Phrase-About-Owls-77!"

async function connected(overrides: Partial<Parameters<typeof createFakePort>[0]> = {}) {
  const port = createFakePort({ status: async () => CONNECTED, ...overrides })
  render(<SyncSettings port={port} />)
  await screen.findByText(/Подключено к sync\.example\.com/)
  return port
}

function field(label: string) {
  return screen.getByLabelText(label) as HTMLInputElement
}

function type(label: string, value: string) {
  fireEvent.change(field(label), { target: { value } })
}

function openForm() {
  fireEvent.click(screen.getByRole("button", { name: "Сменить пароль" }))
}

function submit() {
  return screen.getByRole("button", { name: "Сохранить новый пароль" }) as HTMLButtonElement
}

async function fillValid(port: FakePort) {
  type("Старый пароль", OLD)
  type("Новый пароль", STRONG)
  type("Повторите новый пароль", STRONG)
  await waitFor(() => expect(port.checkPassword).toHaveBeenCalledWith(STRONG, "alice"))
  await waitFor(() => expect(submit().disabled).toBe(false))
}

describe("changing the password of the account", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
  })
  afterEach(cleanup)

  it("offers the change only on a connected device", async () => {
    const port = createFakePort()
    render(<SyncSettings port={port} />)
    await screen.findByRole("radio", { name: /Сервер Amby/ })
    expect(screen.queryByRole("button", { name: "Сменить пароль" })).toBeNull()
    cleanup()
    await connected()
    expect(screen.getByRole("button", { name: "Сменить пароль" })).toBeTruthy()
  })

  it("opens a form with the old password, the new one and its repetition, all hidden", async () => {
    await connected()
    openForm()
    for (const label of ["Старый пароль", "Новый пароль", "Повторите новый пароль"]) {
      expect(field(label).type, label).toBe("password")
      expect(field(label).value, label).toBe("")
    }
    // a password manager may fill the current password; the new ones are new
    expect(field("Старый пароль").autocomplete).toBe("current-password")
    expect(field("Новый пароль").autocomplete).toBe("new-password")
    expect(field("Повторите новый пароль").autocomplete).toBe("new-password")
    expect(submit().disabled).toBe(true)
  })

  it("shows the strength of the new password with the same check as the connect wizard", async () => {
    const port = await connected()
    openForm()
    type("Новый пароль", STRONG)
    await waitFor(() =>
      expect(screen.getByTestId("password-strength").textContent).toMatch(/Отличный|Хороший/),
    )
    // the verdict is asked of the application for the user name of the account
    expect(port.checkPassword).toHaveBeenCalledWith(STRONG, "alice")
  })

  it("keeps the button off while any condition is missing", async () => {
    const port = await connected()
    openForm()
    // nothing but the old password
    type("Старый пароль", OLD)
    expect(submit().disabled).toBe(true)
    // a weak new password, even typed twice
    type("Новый пароль", "password1234")
    type("Повторите новый пароль", "password1234")
    await waitFor(() => expect(port.checkPassword).toHaveBeenCalledWith("password1234", "alice"))
    expect(submit().disabled).toBe(true)
    // a strong one that is not repeated the same
    type("Новый пароль", STRONG)
    type("Повторите новый пароль", STRONG + "!")
    await waitFor(() => expect(port.checkPassword).toHaveBeenCalledWith(STRONG, "alice"))
    expect(screen.getByText("Пароли не совпадают")).toBeTruthy()
    expect(submit().disabled).toBe(true)
    // all good but the old password is empty
    type("Повторите новый пароль", STRONG)
    type("Старый пароль", "")
    await waitFor(() => expect(submit().disabled).toBe(true))
    type("Старый пароль", OLD)
    await waitFor(() => expect(submit().disabled).toBe(false))
    expect(port.changePassword).not.toHaveBeenCalled()
  })

  it("sends the old and the new password once, says it is done and clears the form", async () => {
    const port = await connected()
    openForm()
    await fillValid(port)
    fireEvent.click(submit())
    await waitFor(() => expect(port.changePassword).toHaveBeenCalledTimes(1))
    expect(port.changePassword).toHaveBeenCalledWith(OLD, STRONG)
    expect(await screen.findByText("Пароль изменён")).toBeTruthy()
    // the form is closed and holds no password any more
    expect(screen.queryByLabelText("Старый пароль")).toBeNull()
    openForm()
    for (const label of ["Старый пароль", "Новый пароль", "Повторите новый пароль"]) {
      expect(field(label).value, label).toBe("")
    }
  })

  it("closes and clears the form on cancel without calling the application", async () => {
    const port = await connected()
    openForm()
    await fillValid(port)
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }))
    expect(screen.queryByLabelText("Старый пароль")).toBeNull()
    openForm()
    expect(field("Старый пароль").value).toBe("")
    expect(port.changePassword).not.toHaveBeenCalled()
  })

  it.each([
    ["invalid_proof", /^Старый пароль не подошёл\.$/],
    ["keys_conflict", /Ключи были изменены/],
    ["password_unchanged", /совпадает|тот же|такой же/i],
    ["network", /сервер/i],
  ])("explains %s in words and keeps the form for another try", async (code, text) => {
    const port = await connected({
      changePassword: async () => {
        throw new SyncPortError(code)
      },
    })
    openForm()
    await fillValid(port)
    fireEvent.click(submit())
    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toMatch(text)
    expect(alert.textContent).not.toContain(code)
    expect(alert.textContent).not.toContain(STRONG)
    expect(alert.textContent).not.toContain(OLD)
    // nothing was lost: the person can fix the old password and send again
    expect(field("Новый пароль").value).toBe(STRONG)
    await waitFor(() => expect(submit().disabled).toBe(false))
    expect(screen.queryByText("Пароль изменён")).toBeNull()
  })

  it("does not send twice while the first request is running", async () => {
    let release = () => {}
    const port = await connected({
      changePassword: () => new Promise<void>((resolve) => (release = resolve)),
    })
    openForm()
    await fillValid(port)
    fireEvent.click(submit())
    fireEvent.click(submit())
    expect(port.changePassword).toHaveBeenCalledTimes(1)
    release()
    expect(await screen.findByText("Пароль изменён")).toBeTruthy()
  })

  it("has the texts in English as well", async () => {
    await i18n.changeLanguage("en")
    const port = createFakePort({ status: async () => CONNECTED })
    render(<SyncSettings port={port} />)
    await screen.findByText(/sync\.example\.com/)
    fireEvent.click(screen.getByRole("button", { name: "Change password" }))
    type("Old password", OLD)
    type("New password", STRONG)
    type("Repeat the new password", STRONG)
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Save new password" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    )
    fireEvent.click(screen.getByRole("button", { name: "Save new password" }))
    await waitFor(() => expect(port.changePassword).toHaveBeenCalledWith(OLD, STRONG))
    expect(await screen.findByText("Password changed")).toBeTruthy()
  })
})

describe("the codes of the password change", () => {
  afterEach(() => i18n.changeLanguage("ru"))

  it("are known to the interface and have a text in both languages", () => {
    for (const code of ["invalid_proof", "keys_conflict", "password_unchanged"]) {
      expect(KNOWN_SYNC_ERROR_CODES, code).toContain(code)
      for (const language of ["ru", "en"]) {
        expect(i18n.exists(syncErrorKey(code), { lng: language }), `${code} ${language}`).toBe(true)
      }
    }
  })
})
