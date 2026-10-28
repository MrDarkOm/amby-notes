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
vi.mock("./backup-navigation", () => ({ requestOpenRestoredVault: vi.fn(async () => {}) }))
const item: BackupInfo = {
  id: "01JBACKUP",
  createdMs: 1700000000000,
  bytes: 2500,
  files: 3,
  status: "unchecked",
}
const catalog: BackupCatalog = { vault: "/notes", generation: 42, backups: [item] }
function port(overrides: Partial<BackupPort> = {}) {
  return {
    available: true,
    list: vi.fn(async () => catalog),
    verify: vi.fn(async () => ({ ...item, status: "verified" as const })),
    restore: vi.fn(async () => ({ path: "/restored/vault" })),
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
