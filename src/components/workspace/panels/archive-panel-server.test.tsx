// @vitest-environment happy-dom
// The "На сервере" part of the archive panel (docs/sync-plan.md, appendix И, И9–И13, И17, И20).
// Red until the panel shows it (раздел 6). The section is the element `archive-server-section`; its
// rows are `archive-server-row` with a checkbox; the answer to "Вернуть" is
// `archive-server-result` and follows the button.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import { listTrash, type TrashEntry } from "@/lib/storage"
import type { DeletedFileView } from "@/lib/bindings"
import { resolveSyncPort } from "@/lib/sync/sync-port"
import { createFakePort, vaultStatus, VAULT_OFF, type FakePort } from "../sync/fake-sync-port"
import { ArchivePanel } from "./archive-panel"
import type { PanelRenderProps } from "../panel-registry"

vi.mock("@/lib/storage", () => ({
  listTrash: vi.fn(),
  readTrashPreview: vi.fn(),
  restoreTrash: vi.fn(),
  purgeTrash: vi.fn(),
}))
vi.mock("@/lib/confirm", () => ({ confirm: vi.fn() }))
vi.mock("@/lib/sync/sync-port", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sync/sync-port")>()),
  resolveSyncPort: vi.fn(),
}))

const props: PanelRenderProps = {
  treeItems: [],
  selectedId: null,
  vault: "/vault",
  onSelect: vi.fn(),
  onOpenVault: vi.fn(),
}
// Short waits: a missing part must fail in a moment, not after the default timeout.
const FAST = { timeout: 400 }
const DAY = 24 * 60 * 60 * 1000
const local: TrashEntry = {
  id: "local-one",
  name: "Локальная.md",
  originalPath: "Мир/Локальная.md",
  deletedAtMs: Date.now(),
}

function deleted(n: number, overrides: Partial<DeletedFileView> = {}): DeletedFileView {
  return {
    itemId: String(n).padStart(2, "0").repeat(16),
    path: `Заметки/Удалённая ${n}.md`,
    sizeBytes: 1200,
    deletedMs: Date.now() - 3 * DAY,
    keptUntilMs: Date.now() + 27 * DAY,
    device: "otherDevice",
    deviceName: "Рабочий ноутбук",
    ...overrides,
  }
}

let port: FakePort
function open(overrides: Parameters<typeof createFakePort>[0] = {}) {
  port = createFakePort(overrides)
  vi.mocked(resolveSyncPort).mockReturnValue(port)
  return render(<ArchivePanel {...props} />)
}
const section = () => screen.queryByTestId("archive-server-section")
const serverRows = () => screen.queryAllByTestId("archive-server-row")

beforeEach(async () => {
  vi.resetAllMocks()
  await i18n.changeLanguage("ru")
  vi.mocked(listTrash).mockResolvedValue([local])
})
afterEach(cleanup)

describe("И9: where the section is", () => {
  it("shows 'На сервере' below the local trash when sync of the vault is on", async () => {
    open({
      vaultStatus: async () => vaultStatus(),
      deletedFiles: async () => ({
        available: true,
        reason: null,
        files: [deleted(1), deleted(2)],
        truncated: false,
      }),
    })
    const part = await screen.findByTestId("archive-server-section", {}, FAST)
    expect(within(part).getByText("На сервере")).toBeTruthy()
    expect(serverRows()).toHaveLength(2)
    const localRow = await screen.findByText("Локальная", {}, FAST)
    expect(
      localRow.compareDocumentPosition(part) & Node.DOCUMENT_POSITION_FOLLOWING,
      "the section is under the local trash",
    ).toBeTruthy()
  })

  it("has no section and asks the server for nothing when sync is off", async () => {
    open({ vaultStatus: async () => VAULT_OFF })
    await screen.findByText("Локальная", {}, FAST)
    await waitFor(() => expect(port.vaultStatus).toHaveBeenCalled(), FAST)
    expect(section()).toBeNull()
    expect(port.deletedFiles).not.toHaveBeenCalled()
  })

  it("has no section when the vault is linked but switched off", async () => {
    open({ vaultStatus: async () => vaultStatus({ enabled: false, linked: true }) })
    await screen.findByText("Локальная", {}, FAST)
    await waitFor(() => expect(port.vaultStatus).toHaveBeenCalled(), FAST)
    expect(section()).toBeNull()
    expect(port.deletedFiles).not.toHaveBeenCalled()
  })

  it("is asked for once when the section opens", async () => {
    open({ vaultStatus: async () => vaultStatus() })
    await screen.findByTestId("archive-server-section", {}, FAST)
    expect(port.deletedFiles).toHaveBeenCalledTimes(1)
  })
})

describe("И10, И12: a row", () => {
  it("shows the file name, how long ago it was deleted and until when the server keeps it", async () => {
    open({
      vaultStatus: async () => vaultStatus(),
      deletedFiles: async () => ({
        available: true,
        reason: null,
        files: [deleted(1, { deletedMs: Date.now() - 3 * DAY })],
        truncated: false,
      }),
    })
    const row = await screen.findByTestId("archive-server-row", {}, FAST)
    expect(within(row).getByText("Удалённая 1")).toBeTruthy()
    expect(within(row).getByText(/удалён 3 дня назад/)).toBeTruthy()
    expect(within(row).getByText(/хранится до/)).toBeTruthy()
  })
})

describe("И13: no connection and too many files", () => {
  it("shows one calm line when there is no connection and raises no alert", async () => {
    open({
      vaultStatus: async () => vaultStatus(),
      deletedFiles: async () => ({
        available: false,
        reason: "offline",
        files: [],
        truncated: false,
      }),
    })
    const part = await screen.findByTestId("archive-server-section", {}, FAST)
    expect(within(part).getByText("Файлы с сервера появятся, когда будет связь")).toBeTruthy()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(await screen.findByText("Локальная", {}, FAST)).toBeTruthy()
  })

  it("says 'показаны последние 500' when the list was cut", async () => {
    open({
      vaultStatus: async () => vaultStatus(),
      deletedFiles: async () => ({
        available: true,
        reason: null,
        files: [deleted(1)],
        truncated: true,
      }),
    })
    const part = await screen.findByTestId("archive-server-section", {}, FAST)
    expect(within(part).getByText("Показаны последние 500")).toBeTruthy()
  })

  it("says nothing about a cut when the list is whole", async () => {
    open({
      vaultStatus: async () => vaultStatus(),
      deletedFiles: async () => ({
        available: true,
        reason: null,
        files: [deleted(1)],
        truncated: false,
      }),
    })
    await screen.findByTestId("archive-server-section", {}, FAST)
    expect(serverRows()).toHaveLength(1)
    expect(screen.queryByText(/Показаны последние/)).toBeNull()
  })
})

describe("И17: restoring several files and the answer under the button", () => {
  const restoreButton = () => screen.getByRole("button", { name: "Вернуть" })
  const tick = (row: HTMLElement) => fireEvent.click(within(row).getByRole("checkbox"))
  const twoFiles = {
    vaultStatus: async () => vaultStatus(),
    deletedFiles: async () => ({
      available: true,
      reason: null,
      files: [deleted(1), deleted(2)],
      truncated: false,
    }),
  }

  it("sends the ticked files together", async () => {
    open({
      ...twoFiles,
      restoreDeleted: async (ids) => ({
        requested: ids.length,
        restored: ids.length,
        damaged: 0,
        results: ids.map((itemId) => ({ itemId, status: "restored", finalPath: null })),
      }),
    })
    await screen.findByTestId("archive-server-section", {}, FAST)
    for (const row of serverRows()) tick(row)
    fireEvent.click(restoreButton())
    await waitFor(() => expect(port.restoreDeleted).toHaveBeenCalledTimes(1), FAST)
    expect(vi.mocked(port.restoreDeleted).mock.calls[0][0].sort()).toEqual(
      [deleted(1).itemId, deleted(2).itemId].sort(),
    )
  })

  it("keeps the button off until something is ticked", async () => {
    open(twoFiles)
    await screen.findByTestId("archive-server-section", {}, FAST)
    expect((restoreButton() as HTMLButtonElement).disabled).toBe(true)
    tick(serverRows()[0])
    expect((restoreButton() as HTMLButtonElement).disabled).toBe(false)
  })

  it("writes 'Возвращено 1 из 2, одна повреждена' under the button", async () => {
    open({
      ...twoFiles,
      restoreDeleted: async () => ({
        requested: 2,
        restored: 1,
        damaged: 1,
        results: [
          { itemId: deleted(1).itemId, status: "restored", finalPath: null },
          { itemId: deleted(2).itemId, status: "damaged", finalPath: null },
        ],
      }),
    })
    await screen.findByTestId("archive-server-section", {}, FAST)
    for (const row of serverRows()) tick(row)
    fireEvent.click(restoreButton())
    const line = await screen.findByTestId("archive-server-result", {}, FAST)
    expect(line.textContent).toBe("Возвращено 1 из 2, одна повреждена")
    expect(
      restoreButton().compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("writes 'Возвращено 2 из 2' when all came back", async () => {
    open({
      ...twoFiles,
      restoreDeleted: async (ids) => ({
        requested: ids.length,
        restored: ids.length,
        damaged: 0,
        results: ids.map((itemId) => ({ itemId, status: "restored", finalPath: null })),
      }),
    })
    await screen.findByTestId("archive-server-section", {}, FAST)
    for (const row of serverRows()) tick(row)
    fireEvent.click(restoreButton())
    const line = await screen.findByTestId("archive-server-result", {}, FAST)
    expect(line.textContent).toBe("Возвращено 2 из 2")
  })

  it("tells the name a file got when its path was taken (И15)", async () => {
    open({
      vaultStatus: async () => vaultStatus(),
      deletedFiles: async () => ({
        available: true,
        reason: null,
        files: [deleted(1)],
        truncated: false,
      }),
      restoreDeleted: async () => ({
        requested: 1,
        restored: 1,
        damaged: 0,
        results: [
          {
            itemId: deleted(1).itemId,
            status: "restoredRenamed",
            finalPath: "Заметки/Удалённая 1 (1).md",
          },
        ],
      }),
    })
    await screen.findByTestId("archive-server-section", {}, FAST)
    tick(serverRows()[0])
    fireEvent.click(restoreButton())
    const line = await screen.findByTestId("archive-server-result", {}, FAST)
    expect(line.textContent).toContain("Удалённая 1 (1).md")
  })

  it("lists the section again after a restore", async () => {
    open({
      ...twoFiles,
      restoreDeleted: async (ids) => ({
        requested: ids.length,
        restored: ids.length,
        damaged: 0,
        results: ids.map((itemId) => ({ itemId, status: "restored", finalPath: null })),
      }),
    })
    await screen.findByTestId("archive-server-section", {}, FAST)
    tick(serverRows()[0])
    fireEvent.click(restoreButton())
    await waitFor(() => expect(port.deletedFiles).toHaveBeenCalledTimes(2), FAST)
  })
})

describe("И11а: a cloud on a trash entry that is also on the server", () => {
  it("marks the entry 'есть на сервере до …' and adds no row to the server section", async () => {
    const until = Date.now() + 20 * DAY
    open({
      vaultStatus: async () => vaultStatus(),
      deletedFiles: async () => ({
        available: true,
        reason: null,
        files: [],
        truncated: false,
        trashOnServer: [
          {
            trashId: "local-one",
            itemId: "01".repeat(16),
            deletedMs: Date.now() - 10 * DAY,
            keptUntilMs: until,
            device: "otherDevice",
            deviceName: null,
          },
        ],
      }),
    })
    const mark = await screen.findByLabelText(/^Есть на сервере до /, {}, FAST)
    const formatted = new Intl.DateTimeFormat("ru", { dateStyle: "medium" }).format(until)
    expect(mark.getAttribute("aria-label")).toContain(formatted)
    expect(serverRows()).toHaveLength(0)
  })

  it("marks nothing when the server part is not available", async () => {
    open({
      vaultStatus: async () => vaultStatus(),
      deletedFiles: async () => ({
        available: false,
        reason: "offline",
        files: [],
        truncated: false,
        trashOnServer: [
          {
            trashId: "local-one",
            itemId: "01".repeat(16),
            deletedMs: Date.now(),
            keptUntilMs: Date.now() + DAY,
            device: "otherDevice",
            deviceName: null,
          },
        ],
      }),
    })
    await screen.findByTestId("archive-server-section", {}, FAST)
    expect(screen.queryByLabelText(/^Есть на сервере до /)).toBeNull()
  })

  it("marks nothing when no entry is on the server", async () => {
    open({ vaultStatus: async () => vaultStatus() })
    await screen.findByTestId("archive-server-section", {}, FAST)
    expect(screen.queryByLabelText(/^Есть на сервере до /)).toBeNull()
  })
})
