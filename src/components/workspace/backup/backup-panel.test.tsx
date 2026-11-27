// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import {
  BackupOperationError,
  type BackupPort,
  type BackupCatalog,
  type BackupInfo,
} from "@/lib/storage"
import { BackupPanel } from "./backup-panel"
import { requestOpenRestoredVault } from "./backup-navigation"
import { confirm } from "@/lib/confirm"
vi.mock("./backup-navigation", () => ({ requestOpenRestoredVault: vi.fn(async () => {}) }))
vi.mock("@/lib/confirm", () => ({ confirm: vi.fn(async () => true) }))
const item: BackupInfo = {
  id: "01JBACKUP",
  createdMs: 1700000000000,
  bytes: 2500,
  files: 3,
  status: "unchecked",
  origin: "appData",
  deletable: true,
  expiresMs: null,
}
const catalog: BackupCatalog = { vault: "/notes", generation: 42, backups: [item] }
function port(overrides: Partial<BackupPort> = {}) {
  return {
    available: true,
    list: vi.fn(async () => catalog),
    verify: vi.fn(async () => ({ ...item, status: "verified" as const })),
    restore: vi.fn(async () => ({ path: "/restored/vault" })),
    remove: vi.fn(async () => {}),
    reveal: vi.fn(async () => {}),
    ...overrides,
  }
}
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }))
beforeEach(async () => {
  vi.clearAllMocks()
  await i18n.changeLanguage("ru")
})
afterEach(cleanup)
describe("verified backups", () => {
  it("does not claim verification from metadata; verifies on demand in the pinned generation", async () => {
    const fake = port()
    render(<BackupPanel vault="/notes" port={fake} />)
    await screen.findByText("Будет проверена перед восстановлением")
    expect(fake.list).toHaveBeenCalledWith("/notes")
    expect(fake.verify).not.toHaveBeenCalled()
    click("Проверить")
    await screen.findByText("Проверена")
    expect(fake.verify).toHaveBeenCalledWith(42, item.id)
  })
  it("explains a separate restore before requesting a destination and never opens it automatically", async () => {
    const fake = port()
    render(<BackupPanel vault="/notes" port={fake} />)
    await screen.findByRole("button", { name: "Восстановить…" })
    click("Восстановить…")
    expect(fake.restore).not.toHaveBeenCalled()
    expect(screen.getByRole("dialog").textContent).toMatch(/отдельную|новое хранилище/)
    click("Выбрать папку и восстановить")
    await screen.findByText("Хранилище восстановлено")
    expect(fake.restore).toHaveBeenCalledWith(42, item.id, expect.any(String))
    expect(requestOpenRestoredVault).not.toHaveBeenCalled()
    click("Открыть в Amby")
    expect(requestOpenRestoredVault).toHaveBeenCalledWith("/restored/vault")
  })
  it("does not report success when the folder picker is canceled", async () => {
    const fake = port({ restore: vi.fn(async () => null) })
    render(<BackupPanel vault="/notes" port={fake} />)
    await screen.findByRole("button", { name: "Восстановить…" })
    click("Восстановить…")
    click("Выбрать папку и восстановить")
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Восстановить…" }).hasAttribute("disabled")).toBe(
        false,
      ),
    )
    expect(screen.queryByText("Хранилище восстановлено")).toBeNull()
    expect(requestOpenRestoredVault).not.toHaveBeenCalled()
  })
  it("keeps failed verification visible and prevents restoration of a damaged copy", async () => {
    const fake = port({
      verify: vi.fn(async () => {
        throw new BackupOperationError("backup_invalid")
      }),
    })
    render(<BackupPanel vault="/notes" port={fake} />)
    await screen.findByRole("button", { name: "Проверить" })
    click("Проверить")
    await screen.findByText("Копия повреждена")
    expect(screen.getByRole("button", { name: "Восстановить…" }).hasAttribute("disabled")).toBe(
      true,
    )
    expect(fake.restore).not.toHaveBeenCalled()
  })
  it("does not call a backup damaged because of a temporary command failure", async () => {
    const fake = port({
      verify: vi.fn(async () => {
        throw new BackupOperationError("backup_failed")
      }),
    })
    render(<BackupPanel vault="/notes" port={fake} />)
    await screen.findByRole("button", { name: "Проверить" })
    click("Проверить")
    await screen.findByRole("alert")
    expect(screen.queryByText("Копия повреждена")).toBeNull()
    expect(screen.getByRole("button", { name: "Восстановить…" }).hasAttribute("disabled")).toBe(
      false,
    )
  })
  it("ignores a stale initial catalog after another vault is selected", async () => {
    let finish!: (value: BackupCatalog) => void
    const fake = port({
      list: vi.fn((vault) =>
        vault === "/notes"
          ? new Promise<BackupCatalog>((resolve) => {
              finish = resolve
            })
          : Promise.resolve({ vault, generation: 45, backups: [] }),
      ),
    })
    const view = render(<BackupPanel vault="/notes" port={fake} />)
    view.rerender(<BackupPanel vault="/other" port={fake} />)
    await screen.findByText(/Копий пока нет/)
    await act(async () => finish(catalog))
    expect(screen.queryByRole("button", { name: "Восстановить…" })).toBeNull()
  })
  it("restarts listing for the new vault when an old verification finishes", async () => {
    let finish!: (value: BackupInfo) => void
    const fake = port({
      verify: vi.fn(
        () =>
          new Promise<BackupInfo>((resolve) => {
            finish = resolve
          }),
      ),
      list: vi.fn(async (vault) => ({
        ...catalog,
        vault,
        backups: vault === "/notes" ? [item] : [],
      })),
    })
    const view = render(<BackupPanel vault="/notes" port={fake} />)
    await screen.findByRole("button", { name: "Проверить" })
    click("Проверить")
    view.rerender(<BackupPanel vault="/other" port={fake} />)
    await act(async () => finish({ ...item, status: "verified" }))
    await screen.findByText(/Копий пока нет/)
    expect(fake.list).toHaveBeenCalledWith("/other")
    expect(screen.queryByText("Проверена")).toBeNull()
  })
})
describe("the copy before sync", () => {
  it("is one line with its creation date and can be shown in the file manager", async () => {
    const fake = port()
    render(<BackupPanel vault="/notes" port={fake} />)
    const date = new Date(item.createdMs).toLocaleString("ru")
    await screen.findByText(`Копия перед синхронизацией: создана ${date}`)
    click("Показать")
    await waitFor(() => expect(fake.reveal).toHaveBeenCalledWith(42, item.id))
  })

  it("is deleted only after the confirmation, then the list is read again", async () => {
    const fake = port()
    render(<BackupPanel vault="/notes" port={fake} />)
    await screen.findByRole("button", { name: "Удалить" })
    vi.mocked(confirm).mockResolvedValueOnce(false)
    click("Удалить")
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(fake.remove).not.toHaveBeenCalled()
    click("Удалить")
    await waitFor(() => expect(fake.remove).toHaveBeenCalledWith(42, item.id))
    await waitFor(() => expect(fake.list).toHaveBeenCalledTimes(2))
  })

  it("asks about one deletion at a time: a second copy cannot be queued while the question is open", async () => {
    const newer = { ...item, id: "01JNEWER", createdMs: 1700000500000 }
    const old = { ...item, id: "01JOLD", origin: "legacy" as const }
    const fake = port({ list: vi.fn(async () => ({ ...catalog, backups: [newer, old] })) })
    let answer: (value: boolean) => void = () => {}
    vi.mocked(confirm).mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (answer = resolve)),
    )
    render(<BackupPanel vault="/notes" port={fake} />)
    const oldButton = await screen.findByRole("button", { name: "Удалить старую копию" })
    fireEvent.click(oldButton)
    fireEvent.click(oldButton)
    fireEvent.click(screen.getByRole("button", { name: "Удалить" }))
    expect(confirm).toHaveBeenCalledTimes(1)
    await act(async () => answer(true))
    await waitFor(() => expect(fake.remove).toHaveBeenCalledTimes(1))
    expect(fake.remove).toHaveBeenCalledWith(42, old.id)
    expect(fake.remove).not.toHaveBeenCalledWith(42, newer.id)
  })

  it("names the copy in the question, so two questions never look the same", async () => {
    const fake = port()
    render(<BackupPanel vault="/notes" port={fake} />)
    fireEvent.click(await screen.findByRole("button", { name: "Удалить" }))
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    const asked = vi.mocked(confirm).mock.calls[0][0]
    expect(asked.title).toContain(new Date(item.createdMs).toLocaleString("ru"))
  })

  it("tells when the automatic deletion is due", async () => {
    const fake = port({
      list: vi.fn(async () => ({
        ...catalog,
        backups: [{ ...item, expiresMs: 1700000000000 + 14 * 86400000 }],
      })),
    })
    render(<BackupPanel vault="/notes" port={fake} />)
    await screen.findByText(/удалит её сам/)
  })

  it("offers only an old copy that the vault's receipt names, as an old copy", async () => {
    const stranger = { ...item, id: "01JSTRANGER", origin: "legacy" as const, deletable: false }
    const old = { ...item, id: "01JOLD", origin: "legacy" as const, deletable: true }
    const fake = port({ list: vi.fn(async () => ({ ...catalog, backups: [stranger, old] })) })
    render(<BackupPanel vault="/notes" port={fake} />)
    await screen.findByRole("button", { name: "Удалить старую копию" })
    expect(screen.getAllByRole("button", { name: "Удалить старую копию" })).toHaveLength(1)
    expect(screen.getAllByRole("button", { name: "Показать" })).toHaveLength(1)
  })

  it("says that a missing copy is not a problem and enabling makes a new one", async () => {
    const fake = port({ list: vi.fn(async () => ({ ...catalog, backups: [] })) })
    render(<BackupPanel vault="/notes" port={fake} missing />)
    await screen.findByText(/Копии перед синхронизацией не нашлось/)
  })
})
