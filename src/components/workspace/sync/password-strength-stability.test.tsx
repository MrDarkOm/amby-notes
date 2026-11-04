// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import i18n from "@/lib/i18n"
import type { PasswordCheck } from "@/lib/sync/sync-port"
import { ConnectWizard } from "./connect-wizard"
import { SyncSettings } from "./sync-settings"
import { CONNECTED, createFakePort } from "./fake-sync-port"

const OLD = "Correct-Horse-Battery-Staple-42!"
const STRONG = "A-Brand-New-Phrase-About-Owls-77!"
const NEXT = `${STRONG}8`

const good: PasswordCheck = {
  ok: true,
  score: 4,
  length: 33,
  minLength: 12,
  tooShort: false,
  missing: [],
}

/** A port whose verdict on `NEXT` waits until the test lets it go. */
function gatedPort(overrides: Parameters<typeof createFakePort>[0] = {}) {
  let release = () => {}
  const port = createFakePort({
    checkPassword: (password) =>
      password === NEXT
        ? new Promise<PasswordCheck>((resolve) => (release = () => resolve(good)))
        : Promise.resolve(good),
    ...overrides,
  })
  return { port, release: () => release() }
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

describe("the strength hint while the next verdict is on its way", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
  })
  afterEach(cleanup)

  it("stays in the change-password form and keeps the button off", async () => {
    const { port, release } = gatedPort({ status: async () => CONNECTED })
    render(<SyncSettings port={port} />)
    await screen.findByText(/Подключено к sync\.example\.com/)
    fireEvent.click(screen.getByRole("button", { name: "Сменить пароль" }))
    type("Старый пароль", OLD)
    type("Новый пароль", STRONG)
    type("Повторите новый пароль", STRONG)
    const submit = () => screen.getByRole("button", { name: "Сохранить новый пароль" })
    await waitFor(() => expect((submit() as HTMLButtonElement).disabled).toBe(false))
    const before = screen.getByTestId("password-strength").textContent

    type("Новый пароль", NEXT)
    type("Повторите новый пароль", NEXT)
    await waitFor(() => expect(port.checkPassword).toHaveBeenCalledWith(NEXT, "alice"))
    // the verdict for the new text is still on its way
    expect(screen.getByTestId("password-strength").textContent).toBe(before)
    expect((submit() as HTMLButtonElement).disabled).toBe(true)

    release()
    await waitFor(() => expect((submit() as HTMLButtonElement).disabled).toBe(false))
    expect(screen.getByTestId("password-strength")).toBeTruthy()
  })

  it("stays in the connect wizard and keeps Continue off", async () => {
    const { port, release } = gatedPort()
    render(<ConnectWizard port={port} onConnected={vi.fn()} defaultDeviceName="Mac mini" />)
    fireEvent.click(screen.getByRole("radio", { name: /Свой сервер/ }))
    type("Адрес сервера", "https://sync.example.com")
    fireEvent.click(screen.getByRole("button", { name: "Проверить сервер" }))
    await screen.findByText(/Сервер найден/)
    fireEvent.click(screen.getByRole("button", { name: "Создать учётную запись" }))
    type("Имя пользователя", "alice")
    type("Код приглашения", "AAAA-BBBB-CCCC-DDDD-EEEE")
    type("Пароль", STRONG)
    type("Повторите пароль", STRONG)
    const next = () => screen.getByRole("button", { name: "Продолжить" }) as HTMLButtonElement
    await waitFor(() => expect(next().disabled).toBe(false))
    const before = screen.getByTestId("password-strength").textContent

    type("Пароль", NEXT)
    type("Повторите пароль", NEXT)
    await waitFor(() => expect(port.checkPassword).toHaveBeenCalledWith(NEXT, "alice"))
    expect(screen.getByTestId("password-strength").textContent).toBe(before)
    expect(next().disabled).toBe(true)

    release()
    await waitFor(() => expect(next().disabled).toBe(false))
  })

  it("shows nothing for an empty password", async () => {
    const { port } = gatedPort({ status: async () => CONNECTED })
    render(<SyncSettings port={port} />)
    await screen.findByText(/Подключено к sync\.example\.com/)
    fireEvent.click(screen.getByRole("button", { name: "Сменить пароль" }))
    type("Новый пароль", STRONG)
    await screen.findByTestId("password-strength")
    type("Новый пароль", "")
    await waitFor(() => expect(screen.queryByTestId("password-strength")).toBeNull())
  })
})
