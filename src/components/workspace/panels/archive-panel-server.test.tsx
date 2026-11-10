// @vitest-environment happy-dom
// The server list of the archive panel (docs/sync-plan.md, appendix И, И9а–И13, И17, И20). The
// cloud button "Файлы на сервере" in the header switches the panel to it (И9а); the list is the
// element `archive-server-section`; its rows are `archive-server-row` with a checkbox; the answer to
// "Вернуть" is `archive-server-result` and follows the button.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import { listTrash, type TrashEntry } from "@/lib/storage"
import type { DeletedFileView } from "@/lib/bindings"
import { resolveSyncPort } from "@/lib/sync/sync-port"
import {
  createFakePort,
  emitVaultStatus,
  vaultStatus,
  VAULT_OFF,
  type FakePort,
} from "../sync/fake-sync-port"
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
const search = () => screen.getByLabelText("Найти заметку в архиве…")
const cloudButton = () => screen.queryByRole("button", { name: "Файлы на сервере" })
/** Presses the cloud button of the header and waits for the server list (И9а). */
async function showServer() {
  fireEvent.click(await screen.findByRole("button", { name: "Файлы на сервере" }, FAST))
  return await screen.findByTestId("archive-server-section", {}, FAST)
}

beforeEach(async () => {
  vi.resetAllMocks()
  await i18n.changeLanguage("ru")
  vi.mocked(listTrash).mockResolvedValue([local])
})
afterEach(cleanup)

describe("И9а: the cloud button and the switch", () => {
  const twoDeleted = {
    vaultStatus: async () => vaultStatus(),
    deletedFiles: async () => ({
      available: true,
      reason: null,
      files: [deleted(1), deleted(2)],
      truncated: false,
    }),
  }

  it("shows the local trash first and no server section under it", async () => {
    open(twoDeleted)
    expect(await screen.findByText("Локальная", {}, FAST)).toBeTruthy()
    await screen.findByRole("button", { name: "Файлы на сервере" }, FAST)
    expect(section()).toBeNull()
    expect(serverRows()).toHaveLength(0)
  })

  it("has the cloud button, not pressed, when sync of the vault is on", async () => {
    open(twoDeleted)
    const button = await screen.findByRole("button", { name: "Файлы на сервере" }, FAST)
    expect(button.getAttribute("aria-pressed")).toBe("false")
    expect(button.getAttribute("title")).toBe("Файлы на сервере")
  })

  it("switches to the server list, pressed, and back to the trash", async () => {
    open(twoDeleted)
    await screen.findByText("Локальная", {}, FAST)
    const part = await showServer()
    expect(serverRows()).toHaveLength(2)
    expect(within(part).getByText("Удалённая 1")).toBeTruthy()
    expect(screen.queryByText("Локальная")).toBeNull()
    expect(cloudButton()?.getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(cloudButton() as HTMLElement)
    expect(await screen.findByText("Локальная", {}, FAST)).toBeTruthy()
    expect(section()).toBeNull()
    expect(cloudButton()?.getAttribute("aria-pressed")).toBe("false")
  })

  it("has no button and asks the server for nothing when sync is off", async () => {
    open({ vaultStatus: async () => VAULT_OFF })
    await screen.findByText("Локальная", {}, FAST)
    await waitFor(() => expect(port.vaultStatus).toHaveBeenCalled(), FAST)
    expect(cloudButton()).toBeNull()
    expect(port.deletedFiles).not.toHaveBeenCalled()
  })

  it("has no button when the vault is linked but switched off", async () => {
    open({ vaultStatus: async () => vaultStatus({ enabled: false, linked: true }) })
    await screen.findByText("Локальная", {}, FAST)
    await waitFor(() => expect(port.vaultStatus).toHaveBeenCalled(), FAST)
    expect(cloudButton()).toBeNull()
    expect(port.deletedFiles).not.toHaveBeenCalled()
  })

  it("asks the app for the list when the panel opens and again for the switch (И13а)", async () => {
    // The app answers from its own cache until a tombstone changes, so a press costs no requests
    // to the server unless something was deleted meanwhile.
    open(twoDeleted)
    await waitFor(() => expect(port.deletedFiles).toHaveBeenCalledTimes(1), FAST)
    await showServer()
    expect(port.deletedFiles).toHaveBeenCalledTimes(2)
  })

  it("searches the shown list: the server list while it shows, the trash otherwise", async () => {
    vi.mocked(listTrash).mockResolvedValue([local, { ...local, id: "two", name: "Другая.md" }])
    open(twoDeleted)
    await screen.findByText("Локальная", {}, FAST)
    await showServer()
    const box = search() as HTMLInputElement
    fireEvent.change(box, { target: { value: "Удалённая 2" } })
    expect(serverRows()).toHaveLength(1)
    expect(screen.getByText("Удалённая 2")).toBeTruthy()
    fireEvent.change(box, { target: { value: "нет такой" } })
    expect(serverRows()).toHaveLength(0)
    expect(screen.getByText("Ничего не найдено")).toBeTruthy()
    fireEvent.click(cloudButton() as HTMLElement)
    fireEvent.change(search(), {
      target: { value: "Другая" },
    })
    expect(screen.getByText("Другая")).toBeTruthy()
    expect(screen.queryByText("Локальная")).toBeNull()
  })

  it("shows the search field for the server list even when the trash is empty", async () => {
    vi.mocked(listTrash).mockResolvedValue([])
    open(twoDeleted)
    await showServer()
    expect(search()).toBeTruthy()
  })

  it("does not remember the choice between launches", async () => {
    const first = open(twoDeleted)
    await showServer()
    first.unmount()
    open(twoDeleted)
    expect(await screen.findByText("Локальная", {}, FAST)).toBeTruthy()
    expect(section()).toBeNull()
    expect(cloudButton()?.getAttribute("aria-pressed")).toBe("false")
  })

  it("returns to the trash by itself when sync goes off while the server list shows", async () => {
    open(twoDeleted)
    await showServer()
    emitVaultStatus(VAULT_OFF)
    expect(await screen.findByText("Локальная", {}, FAST)).toBeTruthy()
    expect(section()).toBeNull()
    await waitFor(() => expect(cloudButton()).toBeNull(), FAST)
  })
})

describe("И10а: no service files", () => {
  it("shows no row of the trash for a path inside .amby, however it got there", async () => {
    vi.mocked(listTrash).mockResolvedValue([
      local,
      {
        id: "svc",
        name: "meta.json",
        originalPath: ".amby/conflicts/c1/meta.json",
        deletedAtMs: Date.now(),
      },
      {
        id: "svc2",
        name: "base",
        originalPath: ".amby/conflicts/c1/base",
        deletedAtMs: Date.now(),
      },
    ])
    open({ vaultStatus: async () => VAULT_OFF })
    expect(await screen.findByText("Локальная", {}, FAST)).toBeTruthy()
    expect(screen.queryByText("meta.json")).toBeNull()
    expect(screen.queryByText("base")).toBeNull()
    expect(screen.queryByText(/\.amby\/conflicts/)).toBeNull()
  })

  it("counts only the entries it shows and says the trash is empty when only service ones remain", async () => {
    vi.mocked(listTrash).mockResolvedValue([
      {
        id: "svc",
        name: "meta.json",
        originalPath: ".amby/conflicts/c1/meta.json",
        deletedAtMs: Date.now(),
      },
    ])
    open({ vaultStatus: async () => VAULT_OFF })
    expect(await screen.findByText("Архив пуст", {}, FAST)).toBeTruthy()
    expect(screen.queryByLabelText("Найти заметку в архиве…")).toBeNull()
  })

  it("lists no server row for a service path even if the list carries one", async () => {
    open({
      vaultStatus: async () => vaultStatus(),
      deletedFiles: async () => ({
        available: true,
        reason: null,
        files: [deleted(1), deleted(2, { path: ".amby/properties/prop_01.jsonl" })],
        truncated: false,
      }),
    })
    await showServer()
    expect(serverRows()).toHaveLength(1)
  })

  it("puts no cloud on a service entry of the trash", async () => {
    vi.mocked(listTrash).mockResolvedValue([
      local,
      {
        id: "svc",
        name: "meta.json",
        originalPath: ".amby/conflicts/c1/meta.json",
        deletedAtMs: Date.now(),
      },
    ])
    open({
      vaultStatus: async () => vaultStatus(),
      deletedFiles: async () => ({
        available: true,
        reason: null,
        files: [],
        truncated: false,
        trashOnServer: [
          {
            trashId: "svc",
            itemId: "01".repeat(16),
            deletedMs: Date.now(),
            keptUntilMs: Date.now() + DAY,
            device: "otherDevice",
            deviceName: null,
          },
        ],
      }),
    })
    await screen.findByText("Локальная", {}, FAST)
    await waitFor(() => expect(port.deletedFiles).toHaveBeenCalled(), FAST)
    expect(screen.queryByLabelText(/^Есть на сервере до /)).toBeNull()
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
    await showServer()
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
    const part = await showServer()
    expect(within(part).getByText("Файлы с сервера появятся, когда будет связь")).toBeTruthy()
    expect(screen.queryByRole("alert")).toBeNull()
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
    const part = await showServer()
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
    await showServer()
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
    await showServer()
    for (const row of serverRows()) tick(row)
    fireEvent.click(restoreButton())
    await waitFor(() => expect(port.restoreDeleted).toHaveBeenCalledTimes(1), FAST)
    expect(vi.mocked(port.restoreDeleted).mock.calls[0][0].sort()).toEqual(
      [deleted(1).itemId, deleted(2).itemId].sort(),
    )
  })

  it("keeps the button off until something is ticked", async () => {
    open(twoFiles)
    await showServer()
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
    await showServer()
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
    await showServer()
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
    await showServer()
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
    await showServer()
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
    await waitFor(() => expect(port.deletedFiles).toHaveBeenCalled(), FAST)
    expect(screen.queryByLabelText(/^Есть на сервере до /)).toBeNull()
  })

  it("marks nothing when no entry is on the server", async () => {
    open({ vaultStatus: async () => vaultStatus() })
    await waitFor(() => expect(port.deletedFiles).toHaveBeenCalled(), FAST)
    expect(screen.queryByLabelText(/^Есть на сервере до /)).toBeNull()
  })
})

describe("И9а, И13: the lists follow the sync while the panel is open", () => {
  const withList = () => {
    let files: DeletedFileView[] = []
    const deletedFiles = vi.fn(async () => ({
      available: true,
      reason: null,
      files,
      truncated: false,
      trashOnServer: [],
    }))
    return {
      overrides: { vaultStatus: async () => vaultStatus(), deletedFiles },
      deletedFiles,
      set: (next: DeletedFileView[]) => {
        files = next
      },
    }
  }

  it("asks for the server list again each time the cloud is pressed", async () => {
    const server = withList()
    open(server.overrides)
    await screen.findByText("Локальная", {}, FAST)
    await waitFor(() => expect(server.deletedFiles).toHaveBeenCalled(), FAST)
    const before = server.deletedFiles.mock.calls.length
    server.set([deleted(1)])
    await showServer()
    await waitFor(() => expect(serverRows()).toHaveLength(1), FAST)
    expect(server.deletedFiles.mock.calls.length).toBeGreaterThan(before)
  })

  it("a pass of the sync brings a file deleted elsewhere into the open server list", async () => {
    const server = withList()
    open(server.overrides)
    await showServer()
    expect(serverRows()).toHaveLength(0)
    server.set([deleted(1)])
    emitVaultStatus(vaultStatus())
    await waitFor(() => expect(serverRows()).toHaveLength(1), { timeout: 1500 })
  })

  it("a pass of the sync re-reads the local trash that the sync put a file into", async () => {
    const server = withList()
    open(server.overrides)
    await screen.findByText("Локальная", {}, FAST)
    vi.mocked(listTrash).mockResolvedValue([
      local,
      { id: "from-sync", name: "Танго.md", originalPath: "Танго.md", deletedAtMs: Date.now() },
    ])
    emitVaultStatus(vaultStatus())
    expect(await screen.findByText("Танго", {}, { timeout: 1500 })).toBeTruthy()
  })
})
