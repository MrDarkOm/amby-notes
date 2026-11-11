// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

import i18n from "@/lib/i18n"
import { SyncPortError } from "@/lib/sync/sync-port"
import { RenameIdentityForm } from "./rename-identity"
import { CONNECTED, createFakePort } from "./fake-sync-port"

const OLD_PASSWORD = "Correct-Horse-Battery-Staple-42!"

function field(label: string) {
  return screen.getByLabelText(label) as HTMLInputElement
}

function type(label: string, value: string) {
  fireEvent.change(field(label), { target: { value } })
}

describe("renaming the connected account", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
  })

  afterEach(cleanup)

  it("starts with the new username and current password empty", () => {
    const port = createFakePort()
    render(<RenameIdentityForm mode="account" username="alice" port={port} onClose={vi.fn()} />)

    expect(field("Новое имя пользователя").value).toBe("")
    expect(field("Текущий пароль").value).toBe("")
    expect(field("Текущий пароль").type).toBe("password")
    expect((screen.getByRole("button", { name: "Сохранить" }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it.each(["", "alice", "Alice", "-bob", "bob-", "bad name", "a".repeat(65)])(
    "keeps save disabled for an invalid or unchanged username %s",
    (username) => {
      const port = createFakePort()
      render(<RenameIdentityForm mode="account" username="alice" port={port} onClose={vi.fn()} />)
      type("Новое имя пользователя", username)
      type("Текущий пароль", OLD_PASSWORD)
      expect(
        (screen.getByRole("button", { name: "Сохранить" }) as HTMLButtonElement).disabled,
      ).toBe(true)
      expect(port.renameAccount).not.toHaveBeenCalled()
    },
  )

  it("renames the account with the current password and closes without exposing it", async () => {
    const port = createFakePort()
    const onClose = vi.fn()
    render(<RenameIdentityForm mode="account" username="alice" port={port} onClose={onClose} />)
    type("Новое имя пользователя", "bob")
    type("Текущий пароль", OLD_PASSWORD)
    const submit = screen.getByRole("button", { name: "Сохранить" })
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    await waitFor(() => expect(port.renameAccount).toHaveBeenCalledWith("bob", OLD_PASSWORD))
    expect(onClose).toHaveBeenCalledWith(true)
    expect(screen.queryByText(OLD_PASSWORD)).toBeNull()
  })

  it("keeps the form and translates a wrong current password", async () => {
    const port = createFakePort({
      renameAccount: async () => {
        throw new SyncPortError("invalid_proof")
      },
    })
    const onClose = vi.fn()
    render(<RenameIdentityForm mode="account" username="alice" port={port} onClose={onClose} />)
    type("Новое имя пользователя", "bob")
    type("Текущий пароль", OLD_PASSWORD)
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }))
    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toMatch(/парол/i)
    expect(alert.textContent).not.toContain("invalid_proof")
    expect(onClose).not.toHaveBeenCalled()
    expect(field("Новое имя пользователя").value).toBe("bob")
  })

  it("does not submit twice and can be cancelled while idle", async () => {
    let release!: () => void
    const port = createFakePort({
      renameAccount: () => new Promise((resolve) => (release = () => resolve(CONNECTED))),
    })
    const onClose = vi.fn()
    render(<RenameIdentityForm mode="account" username="alice" port={port} onClose={onClose} />)
    type("Новое имя пользователя", "bob")
    type("Текущий пароль", OLD_PASSWORD)
    const submit = screen.getByRole("button", { name: "Сохранить" })
    fireEvent.click(submit)
    fireEvent.click(submit)
    expect(port.renameAccount).toHaveBeenCalledTimes(1)
    expect((screen.getByRole("button", { name: "Отмена" }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    release()
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true))
  })
})

describe("renaming a device", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
  })

  afterEach(cleanup)

  it("requires a changed safe device name", () => {
    const port = createFakePort()
    render(
      <RenameIdentityForm
        mode="device"
        deviceId="d1"
        name="Mac mini"
        port={port}
        onClose={vi.fn()}
      />,
    )
    const submit = screen.getByRole("button", { name: "Сохранить" })
    expect(field("Имя устройства").value).toBe("Mac mini")
    expect(submit.disabled).toBe(true)
    type("Имя устройства", "Ноутбук дома")
    expect(submit.disabled).toBe(false)
    type("Имя устройства", "a".repeat(65))
    expect(submit.disabled).toBe(true)
    type("Имя устройства", "bad\u0000name")
    expect(submit.disabled).toBe(true)
  })

  it("renames the selected device and closes", async () => {
    const port = createFakePort()
    const onClose = vi.fn()
    render(
      <RenameIdentityForm
        mode="device"
        deviceId="d2"
        name="Ноутбук"
        port={port}
        onClose={onClose}
      />,
    )
    type("Имя устройства", "Ноутбук дома")
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }))
    await waitFor(() => expect(port.renameDevice).toHaveBeenCalledWith("d2", "Ноутбук дома"))
    expect(onClose).toHaveBeenCalledWith(true)
  })

  it("keeps the device form on a server error and never shows the machine code", async () => {
    const port = createFakePort({
      renameDevice: async () => {
        throw new SyncPortError("network")
      },
    })
    const onClose = vi.fn()
    render(
      <RenameIdentityForm
        mode="device"
        deviceId="d2"
        name="Ноутбук"
        port={port}
        onClose={onClose}
      />,
    )
    type("Имя устройства", "Ноутбук дома")
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }))
    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toMatch(/сервер|связ/i)
    expect(alert.textContent).not.toContain("network")
    expect(onClose).not.toHaveBeenCalled()
  })
})
