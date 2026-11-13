// @vitest-environment happy-dom
// The password for the dangerous actions of sync (docs/sync-plan.md, appendix Ц, Ц4, Ц5): deleting the
// server copy asks for the current password and keeps asking while it is wrong; after a password change the
// application offers to disconnect the other devices. Behaviour only. Written before the code.
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { SyncPortError, type SyncPort } from "@/lib/sync/sync-port"
import type { DeviceView } from "@/lib/bindings"
import { ConfirmDialogHost } from "@/components/confirm-dialog-host"
import { useVaultStore } from "../use-vault-store"
import { AccountStorage } from "./account-storage"
import { SyncSettings } from "./sync-settings"
import { ACCOUNT_STANDARD, CONNECTED, createFakePort, type FakePort } from "./fake-sync-port"

const SPACE_ID = ACCOUNT_STANDARD.spaces[0].spaceId
const SPACE_NAME = ACCOUNT_STANDARD.spaces[0].name as string
const SECRET = "Correct-Horse-Battery-Staple-42!"

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  useVaultStore.setState({
    vault: "/vault",
    vaults: [{ id: "1", name: "Work", path: "/vault" }],
  })
})
afterEach(cleanup)

// ----- Ц4: deleting from the server asks for the password -----

async function mountStorage(overrides: Partial<SyncPort> = {}) {
  const port = createFakePort({ accountOverview: async () => ACCOUNT_STANDARD, ...overrides })
  render(
    <>
      <AccountStorage port={port} />
      <ConfirmDialogHost />
    </>,
  )
  await screen.findByTestId("account-storage")
  return port
}

async function openDelete() {
  const row = screen
    .getAllByTestId("storage-row")
    .find((candidate) => within(candidate).getByTestId("storage-name").textContent === SPACE_NAME)
  if (!row) throw new Error("no row")
  fireEvent.pointerDown(within(row).getByRole("button"), { button: 0, ctrlKey: false })
  fireEvent.click(await screen.findByRole("menuitem", { name: "Удалить с сервера…" }))
  return await screen.findByRole("alertdialog")
}

function fill(box: HTMLElement, name: string, password: string) {
  fireEvent.change(within(box).getByRole("textbox"), { target: { value: name } })
  fireEvent.change(within(box).getByLabelText("Текущий пароль"), { target: { value: password } })
}

function deleteButton(box: HTMLElement) {
  return within(box).getByRole("button", { name: "Удалить с сервера" }) as HTMLButtonElement
}

describe("deleting the server copy needs the current password (Ц4)", () => {
  it("keeps the button closed until the exact name and a password are given, then sends both", async () => {
    const port = await mountStorage()
    const box = await openDelete()
    const password = within(box).getByLabelText("Текущий пароль") as HTMLInputElement
    expect(password.type).toBe("password")
    fireEvent.change(within(box).getByRole("textbox"), { target: { value: SPACE_NAME } })
    expect(deleteButton(box).disabled).toBe(true)
    fill(box, SPACE_NAME, SECRET)
    expect(deleteButton(box).disabled).toBe(false)
    fireEvent.click(deleteButton(box))
    await waitFor(() => expect(port.deleteSpace).toHaveBeenCalledExactlyOnceWith(SPACE_ID, SECRET))
  })

  it("asks again after a wrong password, says so, and deletes nothing", async () => {
    let calls = 0
    const port = await mountStorage({
      deleteSpace: async () => {
        calls += 1
        if (calls === 1) throw new SyncPortError("invalid_proof")
      },
    })
    const box = await openDelete()
    fill(box, SPACE_NAME, "wrong password")
    fireEvent.click(deleteButton(box))
    const again = await screen.findByRole("alertdialog")
    expect(within(again).getByText("Неверный пароль")).toBeTruthy()
    expect(screen.queryByText(/Копия на сервере удалена/)).toBeNull()
    fill(again, SPACE_NAME, SECRET)
    fireEvent.click(deleteButton(again))
    await waitFor(() => expect(calls).toBe(2))
    expect(port.deleteSpace).toHaveBeenLastCalledWith(SPACE_ID, SECRET)
    expect(await screen.findByText(/Копия на сервере удалена/)).toBeTruthy()
  })

  it("never shows the password in the page", async () => {
    await mountStorage({
      deleteSpace: async () => {
        throw new SyncPortError("invalid_proof")
      },
    })
    const box = await openDelete()
    fill(box, SPACE_NAME, "a-very-visible-secret")
    fireEvent.click(deleteButton(box))
    await screen.findByText("Неверный пароль")
    expect(document.body.textContent).not.toMatch(/a-very-visible-secret/)
  })
})

// ----- Ц5: after a password change, offer to disconnect the other devices -----

const OLD = "Correct-Horse-Battery-Staple-42!"
const STRONG = "A-Brand-New-Phrase-About-Owls-77!"

const device = (deviceId: string, name: string, current = false): DeviceView => ({
  deviceId,
  name,
  createdMs: 1_760_000_000_000,
  lastSeenMs: 1_760_000_000_000,
  current,
})

async function changePassword(devices: DeviceView[], overrides: Partial<SyncPort> = {}) {
  const port: FakePort = createFakePort({
    status: async () => CONNECTED,
    listDevices: async () => devices,
    ...overrides,
  })
  render(<SyncSettings port={port} />)
  await screen.findByText(/Подключено к sync\.example\.com/)
  fireEvent.click(screen.getByRole("button", { name: "Сменить пароль" }))
  const type = (label: string, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } })
  type("Старый пароль", OLD)
  type("Новый пароль", STRONG)
  type("Повторите новый пароль", STRONG)
  const submit = () =>
    screen.getByRole("button", { name: "Сохранить новый пароль" }) as HTMLButtonElement
  await waitFor(() => expect(submit().disabled).toBe(false))
  await act(async () => {
    fireEvent.click(submit())
  })
  await waitFor(() => expect(port.changePassword).toHaveBeenCalled())
  return port
}

// The change of the password itself checks the strength of the new one: give the tests time.
describe(
  "disconnecting the other devices after a password change (Ц5)",
  { timeout: 20_000 },
  () => {
    it("asks with the number of the other devices and disconnects them all, not this one", async () => {
      const port = await changePassword([
        device("aa".repeat(16), "Этот Mac", true),
        device("bb".repeat(16), "Windows"),
        device("cc".repeat(16), "Ноутбук"),
      ])
      const question = await screen.findByTestId("disconnect-others")
      expect(question.textContent).toMatch(/Отключить остальные устройства\?/)
      expect(question.textContent).toMatch(/2/)
      fireEvent.click(within(question).getByRole("button", { name: "Отключить" }))
      await waitFor(() => expect(port.disconnectDevice).toHaveBeenCalledTimes(2))
      expect(port.disconnectDevice).toHaveBeenCalledWith("bb".repeat(16))
      expect(port.disconnectDevice).toHaveBeenCalledWith("cc".repeat(16))
      expect(port.disconnectDevice).not.toHaveBeenCalledWith("aa".repeat(16))
      await waitFor(() => expect(screen.queryByTestId("disconnect-others")).toBeNull())
    })

    it("leaves the devices when the person keeps them", async () => {
      const port = await changePassword([
        device("aa".repeat(16), "Этот Mac", true),
        device("bb".repeat(16), "Windows"),
      ])
      const question = await screen.findByTestId("disconnect-others")
      fireEvent.click(within(question).getByRole("button", { name: "Оставить" }))
      await waitFor(() => expect(screen.queryByTestId("disconnect-others")).toBeNull())
      expect(port.disconnectDevice).not.toHaveBeenCalled()
    })

    it("does not ask when this is the only device", async () => {
      const port = await changePassword([device("aa".repeat(16), "Этот Mac", true)])
      await waitFor(() => expect(port.listDevices).toHaveBeenCalled())
      await act(async () => new Promise((resolve) => setTimeout(resolve, 30)))
      expect(screen.queryByTestId("disconnect-others")).toBeNull()
    })

    it("says how many were not disconnected and offers to repeat", async () => {
      let failures = 1
      const port = await changePassword(
        [
          device("aa".repeat(16), "Этот Mac", true),
          device("bb".repeat(16), "Windows"),
          device("cc".repeat(16), "Ноутбук"),
        ],
        {
          disconnectDevice: async (id: string) => {
            if (id === "cc".repeat(16) && failures > 0) {
              failures -= 1
              throw new SyncPortError("network")
            }
          },
        },
      )
      const question = await screen.findByTestId("disconnect-others")
      fireEvent.click(within(question).getByRole("button", { name: "Отключить" }))
      expect(await within(question).findByText(/Не удалось отключить: 1/)).toBeTruthy()
      fireEvent.click(within(question).getByRole("button", { name: "Повторить" }))
      await waitFor(() => expect(screen.queryByTestId("disconnect-others")).toBeNull())
      expect(port.disconnectDevice).toHaveBeenLastCalledWith("cc".repeat(16))
    })
  },
)
