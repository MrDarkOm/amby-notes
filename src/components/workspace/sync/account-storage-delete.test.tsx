// @vitest-environment happy-dom
// Red UI contract for docs/sync-plan.md, appendix Л, Л10–Л11. The server copy is deleted only after
// the shared confirmation has the exact name (or the space ID when its name is unavailable); local files
// are never part of this action. These tests intentionally exercise the public UI, not implementation details.
import type * as React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { SyncPortError, type AccountOverview, type SyncPort } from "@/lib/sync/sync-port"
import { syncErrorMessage } from "@/lib/sync/sync-errors"
import { useVaultStore } from "../use-vault-store"
import { ConfirmDialogHost } from "@/components/confirm-dialog-host"
import { AccountStorage } from "./account-storage"
import { ACCOUNT_STANDARD, ACCOUNT_UNLIMITED, createFakePort } from "./fake-sync-port"

const SPACE_ID = ACCOUNT_STANDARD.spaces[0].spaceId
const SPACE_NAME = ACCOUNT_STANDARD.spaces[0].name as string
const DELETE_LABEL = "Удалить с сервера"
const DELETE_MENU_LABEL = "Удалить с сервера…"
const SUCCESS_TEXT = "Копия на сервере удалена. Локальные файлы остались"

function afterDelete(data: AccountOverview = ACCOUNT_STANDARD): AccountOverview {
  return {
    ...data,
    usage: { ...data.usage, liveBytes: 0, historyBytes: 0, spaces: 0 },
    spaces: [],
  }
}

function rowFor(name: string) {
  const row = screen
    .getAllByTestId("storage-row")
    .find((candidate) => within(candidate).getByTestId("storage-name").textContent === name)
  if (!row) throw new Error(`storage row not found: ${name}`)
  return row
}

let rerenderCurrent: (ui: React.ReactElement) => void = () => {}

/** The storage section with the one shared confirmation host, as App mounts them. */
function screenOf(port: SyncPort, revision: number) {
  return (
    <>
      <AccountStorage port={port} revision={revision} />
      <ConfirmDialogHost />
    </>
  )
}

/** The same mounted section gets another account revision or port. */
function rerenderWith(port: SyncPort, revision: number) {
  rerenderCurrent(screenOf(port, revision))
}

async function mount(
  overrides: Partial<SyncPort> = {},
  data: AccountOverview = ACCOUNT_STANDARD,
  revision = 0,
) {
  const port = createFakePort({ accountOverview: async () => data, ...overrides })
  rerenderCurrent = render(screenOf(port, revision)).rerender
  await screen.findByTestId("account-storage")
  await waitFor(() => expect(port.accountOverview).toHaveBeenCalled())
  return port
}

async function openDelete(name = SPACE_NAME) {
  // A Radix menu opens on pointer down, not on click.
  fireEvent.pointerDown(within(rowFor(name)).getByRole("button"), { button: 0, ctrlKey: false })
  fireEvent.click(await screen.findByRole("menuitem", { name: DELETE_MENU_LABEL }))
  return await screen.findByRole("alertdialog")
}

function requiredInput(box: HTMLElement) {
  return within(box).getByRole("textbox")
}

function actionButton(box: HTMLElement) {
  return within(box).getByRole("button", { name: DELETE_LABEL })
}

/** Ц4: the question also asks for the current password; these Л10 tests give one and check the name. */
const PASSWORD = "Correct-Horse-Battery-Staple-42!"

function fillExact(box: HTMLElement, value = SPACE_NAME) {
  fireEvent.change(requiredInput(box), { target: { value } })
  fireEvent.change(within(box).getByLabelText("Текущий пароль"), { target: { value: PASSWORD } })
}

function settleRadix() {
  return act(() => new Promise<void>((resolve) => setTimeout(resolve, 30)))
}

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  useVaultStore.setState({
    vault: "/vault",
    vaults: [{ id: "1", name: "Work", path: "/vault" }],
  })
})

afterEach(cleanup)

describe("the server-space action in an account-storage row (Л10)", () => {
  it("offers 'Удалить с сервера…' in the row menu", async () => {
    await mount()

    fireEvent.pointerDown(within(rowFor(SPACE_NAME)).getByRole("button"), {
      button: 0,
      ctrlKey: false,
    })

    expect(await screen.findByRole("menuitem", { name: DELETE_MENU_LABEL })).toBeTruthy()
  })

  it("uses the shared dangerous confirmation, shows live and history sizes, and says local files remain", async () => {
    await mount()
    const box = await openDelete()

    expect(box.textContent).toContain("312 МБ")
    expect(box.textContent).toContain("40 МБ")
    expect(box.textContent).toMatch(/локальные файлы.*останутся/i)
    expect(within(box).getByRole("textbox")).toBeTruthy()
    expect(within(box).getByRole("button", { name: DELETE_LABEL })).toBeTruthy()
    expect(within(box).getByRole("button", { name: "Отмена" })).toBeTruthy()
    expect(document.activeElement).toBe(within(box).getByRole("button", { name: "Отмена" }))
  })

  it("requires the exact name: empty and wrong input cannot call deleteSpace", async () => {
    const port = await mount()
    const box = await openDelete()
    const action = actionButton(box)

    expect(action.getAttribute("disabled")).not.toBeNull()
    fillExact(box, "Рабочее")
    expect(action.getAttribute("disabled")).not.toBeNull()
    fireEvent.click(action)
    expect(port.deleteSpace).not.toHaveBeenCalled()

    fillExact(box)
    expect(action.getAttribute("disabled")).toBeNull()
  })

  it("falls back to the space ID when the server name is unavailable", async () => {
    const unnamed = {
      ...ACCOUNT_UNLIMITED,
      spaces: [{ ...ACCOUNT_UNLIMITED.spaces[0], name: null, historyBytes: 40_000_000 }],
    }
    const port = await mount({}, unnamed)
    const box = await openDelete("Название недоступно")

    expect(box.textContent).toContain(unnamed.spaces[0].spaceId)
    fillExact(box, unnamed.spaces[0].spaceId)
    fireEvent.click(actionButton(box))
    await waitFor(() =>
      expect(port.deleteSpace).toHaveBeenCalledWith(unnamed.spaces[0].spaceId, PASSWORD),
    )
  })

  it("does nothing for Cancel, with focus initially on the safe button", async () => {
    const port = await mount()
    const box = await openDelete()
    const cancel = within(box).getByRole("button", { name: "Отмена" })

    expect(document.activeElement).toBe(cancel)
    fireEvent.click(cancel)
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(port.deleteSpace).not.toHaveBeenCalled()
  })

  it("does nothing when the confirmation is dismissed with Escape or outside click", async () => {
    const port = await mount()
    const box = await openDelete()
    fireEvent.keyDown(box, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(port.deleteSpace).not.toHaveBeenCalled()

    await openDelete()
    await settleRadix()
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }))
    await settleRadix()
    expect(screen.queryByRole("alertdialog")).toBeNull()
    expect(port.deleteSpace).not.toHaveBeenCalled()
  })
})

describe("the request and its result (Л11)", () => {
  it("allows only one request while deleteSpace is pending", async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const port = await mount({ deleteSpace: vi.fn(() => pending) })
    const box = await openDelete()
    fillExact(box)
    fireEvent.click(actionButton(box))
    await waitFor(() => expect(port.deleteSpace).toHaveBeenCalledTimes(1))

    const trigger = within(rowFor(SPACE_NAME)).getByRole("button")
    expect(trigger.getAttribute("disabled")).not.toBeNull()
    fireEvent.click(trigger)
    expect(port.deleteSpace).toHaveBeenCalledTimes(1)
    finish()
  })

  it("deletes by ID, then reloads the account overview and shows one inline success", async () => {
    const accountOverview = vi
      .fn()
      .mockResolvedValueOnce(ACCOUNT_STANDARD)
      .mockResolvedValueOnce(afterDelete())
    const port = await mount({ accountOverview })
    const box = await openDelete()
    fillExact(box)
    fireEvent.click(actionButton(box))

    await waitFor(() => expect(port.deleteSpace).toHaveBeenCalledWith(SPACE_ID, PASSWORD))
    await waitFor(() => expect(accountOverview).toHaveBeenCalledTimes(2))
    expect(port.deleteSpace.mock.invocationCallOrder[0]).toBeLessThan(
      accountOverview.mock.invocationCallOrder[1],
    )
    expect(screen.getByText(SUCCESS_TEXT)).toBeTruthy()
    expect(screen.getAllByText(SUCCESS_TEXT)).toHaveLength(1)
    expect(screen.queryByText(SPACE_NAME)).toBeNull()
  })

  it("translates a machine error once under the action and never shows server text", async () => {
    const rawServerText = "server internal path /secret-space"
    await mount({
      deleteSpace: vi.fn(async () => {
        const error = new SyncPortError("timeout")
        error.message = rawServerText
        throw error
      }),
    })
    const box = await openDelete()
    fillExact(box)
    fireEvent.click(actionButton(box))

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toBe(syncErrorMessage(new SyncPortError("timeout"), i18n.t))
    expect(screen.getAllByRole("alert")).toHaveLength(1)
    expect(document.body.textContent).not.toContain(rawServerText)
  })

  it("drops a pending confirmation when the account revision changes", async () => {
    const port = await mount()
    const box = await openDelete()
    // A new account revision: the old question must not answer it.
    rerenderWith(port, 1)
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(port.deleteSpace).not.toHaveBeenCalled()
    expect(box.isConnected).toBe(false)
  })

  it("drops a pending confirmation when the connected port/account changes", async () => {
    const first = await mount()
    await openDelete()
    const second = createFakePort({ accountOverview: async () => ACCOUNT_UNLIMITED })
    rerenderWith(second, 0)
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(first.deleteSpace).not.toHaveBeenCalled()
  })

  it("ignores an old request result after the account revision changes", async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const accountOverview = vi
      .fn()
      .mockResolvedValueOnce(ACCOUNT_STANDARD)
      .mockResolvedValue({ ...ACCOUNT_STANDARD, spaces: [] })
    const port = await mount({ deleteSpace: vi.fn(() => pending), accountOverview })
    const box = await openDelete()
    fillExact(box)
    fireEvent.click(actionButton(box))
    await waitFor(() => expect(port.deleteSpace).toHaveBeenCalledTimes(1))

    rerenderWith(port, 1)
    await waitFor(() => expect(accountOverview).toHaveBeenCalledTimes(2))
    finish()
    await settleRadix()
    expect(screen.queryByText(SUCCESS_TEXT)).toBeNull()
  })
})
