// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { AMBY_SERVER_URL } from "@/lib/sync/amby-server"
import { SyncPortError, unavailableSyncPort } from "@/lib/sync/sync-port"
import { openWebAddressInBrowser } from "../tiptap/external-open"
import { SyncSettings } from "./sync-settings"
import {
  CONNECTED,
  DEVICES,
  DISCONNECTED,
  createFakePort,
  vaultStatus,
  type FakePort,
} from "./fake-sync-port"

vi.mock("../tiptap/external-open", () => ({ openWebAddressInBrowser: vi.fn() }))

function renderSettings(port: FakePort) {
  return render(<SyncSettings port={port} />)
}

function click(name: string | RegExp) {
  fireEvent.click(screen.getByRole("button", { name }))
}

async function connected(overrides: Partial<Parameters<typeof createFakePort>[0]> = {}) {
  const port = createFakePort({ status: async () => CONNECTED, ...overrides })
  renderSettings(port)
  await screen.findByText(/Подключено к sync\.example\.com/)
  return port
}

describe("the server in use", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
  })
  afterEach(cleanup)

  it("says that the Amby server is used, and with its address", async () => {
    const port = createFakePort({
      status: async () => ({
        ...CONNECTED,
        serverUrl: AMBY_SERVER_URL,
        host: new URL(AMBY_SERVER_URL).host,
      }),
    })
    renderSettings(port)
    expect(await screen.findByText(/Подключено к серверу Amby/)).toBeTruthy()
    expect(
      screen.getByText(new RegExp(new URL(AMBY_SERVER_URL).host.replace(/\./g, "\\."))),
    ).toBeTruthy()
  })

  it("keeps showing the address of an own server", async () => {
    await connected()
    expect(screen.queryByText(/сервер[уа]? Amby/)).toBeNull()
  })
})

describe("the Synchronization section of the settings", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
  })
  afterEach(cleanup)

  it("says honestly that the synchronisation of notes is still experimental", async () => {
    // stage Э4: notes do travel now, but only on a test vault until the gates of the plan are
    // passed; the section must not promise more (it used to say that notes do not travel at all)
    const port = createFakePort()
    renderSettings(port)
    await screen.findByRole("radio", { name: /Сервер Amby/ })
    expect(document.body.textContent).toMatch(/в тестовом режиме/)
    expect(document.body.textContent).not.toMatch(/Заметки пока не синхронизируются/)
  })

  it("shows the sync of the open vault under the connection, and only when connected", async () => {
    // stage Э4: the vault is switched on from the same section
    await connected({ vaultStatus: async () => vaultStatus({ phase: "idle" }) })
    expect(await screen.findByTestId("sync-vault")).toBeTruthy()
    cleanup()
    renderSettings(createFakePort())
    await screen.findByRole("radio", { name: /Сервер Amby/ })
    expect(screen.queryByTestId("sync-vault")).toBeNull()
  })

  it("shows the connect wizard when the device is not connected", async () => {
    const port = createFakePort()
    renderSettings(port)
    expect(await screen.findByRole("radio", { name: /Сервер Amby/ })).toBeTruthy()
    expect(screen.queryByText(/Подключено к/)).toBeNull()
  })

  it("shows the connection, the user and the devices when connected", async () => {
    await connected()
    expect(screen.getByText(/alice/)).toBeTruthy()
    await screen.findByText("Mac mini")
    expect(screen.getByText("Ноутбук")).toBeTruthy()
    expect(screen.getByText("Неизвестное устройство")).toBeTruthy()
    expect(screen.queryByRole("radio", { name: /Сервер Amby/ })).toBeNull()
  })

  it("marks this device and offers no disconnect for it", async () => {
    await connected()
    await screen.findByText("Mac mini")
    const row = screen.getByText("Mac mini").closest("li") as HTMLElement
    expect(within(row).getByText("Это устройство")).toBeTruthy()
    expect(within(row).queryByRole("button", { name: /Отключить/ })).toBeNull()
    const other = screen.getByText("Ноутбук").closest("li") as HTMLElement
    expect(within(other).getByRole("button", { name: /Отключить/ })).toBeTruthy()
  })

  it("disconnects another device only after a confirmation", async () => {
    const port = await connected()
    await screen.findByText("Ноутбук")
    fireEvent.click(screen.getByRole("button", { name: "Отключить устройство Ноутбук" }))
    expect(port.disconnectDevice).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }))
    expect(port.disconnectDevice).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Отключить устройство Ноутбук" }))
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить отключение" }))
    await waitFor(() => expect(port.disconnectDevice).toHaveBeenCalledWith("d2"))
    await waitFor(() => expect(port.listDevices.mock.calls.length).toBeGreaterThanOrEqual(2))
  })

  it("shows the error when a device cannot be disconnected", async () => {
    const port = await connected({
      disconnectDevice: async () => {
        throw new SyncPortError("network")
      },
    })
    await screen.findByText("Ноутбук")
    fireEvent.click(screen.getByRole("button", { name: "Отключить устройство Ноутбук" }))
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить отключение" }))
    expect((await screen.findByRole("alert")).textContent).toMatch(/Не удалось связаться/)
    expect(port.disconnectDevice).toHaveBeenCalled()
  })

  it("signs out and goes back to the wizard", async () => {
    const port = await connected()
    port.status.mockResolvedValue(DISCONNECTED)
    click("Выйти на этом устройстве")
    await waitFor(() => expect(port.signOut).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole("radio", { name: /Сервер Amby/ })).toBeTruthy()
    expect(screen.queryByText(/Подключено к/)).toBeNull()
  })

  it("tells when the server could not be told about the sign-out", async () => {
    const port = await connected({ signOut: async () => ({ serverNotified: false }) })
    port.status.mockResolvedValue(DISCONNECTED)
    click("Выйти на этом устройстве")
    expect((await screen.findByRole("status")).textContent).toMatch(/Сервер не удалось уведомить/)
  })

  it("returns to the wizard when the server has disconnected this device", async () => {
    // П19: the token is revoked; the next request tells
    const port = createFakePort({
      status: async () => CONNECTED,
      listDevices: async () => {
        throw new SyncPortError("token_revoked")
      },
    })
    renderSettings(port)
    port.status.mockResolvedValue(DISCONNECTED)
    expect((await screen.findByRole("alert")).textContent).toMatch(/отключено/)
    expect(await screen.findByRole("radio", { name: /Сервер Amby/ })).toBeTruthy()
  })

  it("asks to sign in again when the key store lost the keys", async () => {
    const port = createFakePort({
      status: async () => ({
        ...DISCONNECTED,
        keysMissing: true,
        serverUrl: "https://sync.example.com",
        host: "sync.example.com",
        username: "alice",
      }),
    })
    renderSettings(port)
    expect((await screen.findByRole("status")).textContent).toMatch(/не найдены в связке ключей/)
    expect((screen.getByLabelText("Адрес сервера") as HTMLInputElement).value).toBe(
      "https://sync.example.com",
    )
  })

  it("shows why the state cannot be read", async () => {
    const port = createFakePort({
      status: async () => {
        throw new SyncPortError("keychain_unavailable")
      },
    })
    renderSettings(port)
    expect((await screen.findByRole("alert")).textContent).toMatch(/связк/)
  })

  it("lists the devices again after the wizard connects", async () => {
    const port = createFakePort()
    renderSettings(port)
    await screen.findByRole("radio", { name: /Сервер Amby/ })
    port.status.mockResolvedValue(CONNECTED)
    fireEvent.click(screen.getByRole("radio", { name: /Свой сервер/ }))
    fireEvent.change(screen.getByLabelText("Адрес сервера"), {
      target: { value: "https://sync.example.com" },
    })
    click("Проверить сервер")
    await screen.findByText(/Сервер найден/)
    click("Войти")
    fireEvent.change(screen.getByLabelText("Имя пользователя"), { target: { value: "alice" } })
    fireEvent.change(screen.getByLabelText("Пароль"), { target: { value: "pw" } })
    click("Войти")
    expect(await screen.findByText(/Подключено к sync\.example\.com/)).toBeTruthy()
    await screen.findByText("Ноутбук")
    expect(DEVICES.length).toBe(3)
  })

  it("explains that the browser build cannot sync", async () => {
    render(<SyncSettings port={unavailableSyncPort} />)
    expect(await screen.findByText(/доступна только в приложении для компьютера/)).toBeTruthy()
    expect(screen.queryByRole("radio", { name: /Сервер Amby/ })).toBeNull()
  })

  it("is also available in English", async () => {
    await i18n.changeLanguage("en")
    const port = createFakePort()
    renderSettings(port)
    expect(await screen.findByLabelText("Server address")).toBeTruthy()
    expect(document.body.textContent).toMatch(/works in a test mode/i)
    await i18n.changeLanguage("ru")
  })

  it("does not render a secret", async () => {
    const port = await connected()
    await screen.findByText("Mac mini")
    const text = document.body.textContent ?? ""
    expect(text).not.toMatch(/[0-9a-f]{64}/)
    expect(vi.mocked(port.status)).toHaveBeenCalled()
  })

  describe("the choice of a server", () => {
    it("offers the Amby server as not available yet and cannot select it", async () => {
      renderSettings(createFakePort())
      const amby = (await screen.findByRole("radio", { name: /Сервер Amby/ })) as HTMLInputElement
      expect(amby.disabled).toBe(true)
      expect(amby.checked).toBe(false)
      expect(document.body.textContent).toMatch(/скоро будет/)
      fireEvent.click(amby)
      expect(screen.getByRole("radio", { name: /Сервер Amby/ })).toBeTruthy()
    })

    it("has the own server selected, with the address field", async () => {
      renderSettings(createFakePort())
      const own = (await screen.findByRole("radio", { name: "Свой сервер" })) as HTMLInputElement
      expect(own.checked).toBe(true)
      expect(screen.getByRole("radio", { name: /Сервер Amby/ })).toBeTruthy()
    })

    it("opens the install guide of the server in the browser", async () => {
      renderSettings(createFakePort())
      fireEvent.click(await screen.findByRole("button", { name: /Как поднять свой сервер/ }))
      expect(openWebAddressInBrowser).toHaveBeenCalledWith(
        "https://github.com/MrDarkOm/AmbyNotes-SelfHost",
      )
    })

    it("names the own server only on its option, in both languages", async () => {
      renderSettings(createFakePort())
      await screen.findByRole("radio", { name: /Сервер Amby/ })
      expect(screen.getByText("Синхронизация").parentElement?.textContent).not.toMatch(/собственн/i)
      cleanup()
      await i18n.changeLanguage("en")
      renderSettings(createFakePort())
      await screen.findByLabelText("Server address")
      expect(screen.getByRole("radio", { name: "Your own server" })).toBeTruthy()
      expect(document.body.textContent?.match(/own server/gi)).toHaveLength(2)
      await i18n.changeLanguage("ru")
    })
  })
})
