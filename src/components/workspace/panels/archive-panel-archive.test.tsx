// @vitest-environment happy-dom
// The archive panel after appendix К (docs/sync-plan.md, К6): it lists only `.amby/archive/`
// (through `listArchive`), never the old trash, and has no cloud marks on its rows; «Вернуть» says
// the final name; «Удалить из архива» follows the setting of К4; the cloud button still switches to
// the server list. Written before the code (раздел 6): red until the panel moves to the archive.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import {
  listArchive,
  listTrash,
  purgeArchive,
  readArchivePreview,
  restoreArchive,
  type ArchiveEntry,
} from "@/lib/storage"
import { confirm } from "@/lib/confirm"
import { resolveSyncPort } from "@/lib/sync/sync-port"
import { createFakePort, vaultStatus } from "../sync/fake-sync-port"
import { DEFAULT_PREFS, type DeleteModePref } from "../app-config"
import { useSettingsStore } from "../use-settings-store"
import { ArchivePanel } from "./archive-panel"
import type { PanelRenderProps } from "../panel-registry"

vi.mock("@/lib/storage", () => ({
  listArchive: vi.fn(),
  readArchivePreview: vi.fn(),
  restoreArchive: vi.fn(),
  purgeArchive: vi.fn(),
  // The old trash: the panel must not read it any more (К6); a call is a failure of the test.
  listTrash: vi.fn(),
  readTrashPreview: vi.fn(),
  restoreTrash: vi.fn(),
  purgeTrash: vi.fn(),
  isTauri: () => false,
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
const FAST = { timeout: 400 }
const NOW = Date.now()

const draft: ArchiveEntry = {
  id: "arch-1",
  name: "Черновик.md",
  originalPath: "Мир/Черновик.md",
  archivedAtMs: NOW - 5_000,
}
const idea: ArchiveEntry = {
  id: "arch-2",
  name: "Идея.md",
  originalPath: "Идеи/Идея.md",
  archivedAtMs: NOW - 9_000,
}

function setDeleteMode(deleteMode: DeleteModePref) {
  useSettingsStore.setState({
    prefs: { ...DEFAULT_PREFS, files: { ...DEFAULT_PREFS.files, deleteMode } },
  })
}

const openActions = (name: string) =>
  fireEvent.pointerDown(screen.getByRole("button", { name: `Действия с «${name}»` }), {
    button: 0,
    ctrlKey: false,
  })

beforeEach(async () => {
  vi.resetAllMocks()
  await i18n.changeLanguage("ru")
  setDeleteMode("system")
  vi.mocked(listArchive).mockResolvedValue([draft, idea])
  vi.mocked(listTrash).mockResolvedValue([
    {
      id: "old-trash",
      name: "Из корзины.md",
      originalPath: "Пропавшее/Из корзины.md",
      deletedAtMs: NOW,
    },
  ])
  vi.mocked(restoreArchive).mockResolvedValue({
    primaryId: null,
    primaryPath: "/vault/Мир/Черновик.md",
    pathChanges: [],
    deletedPaths: [],
  })
  vi.mocked(purgeArchive).mockResolvedValue(undefined)
  vi.mocked(confirm).mockResolvedValue(true)
  vi.mocked(resolveSyncPort).mockReturnValue(
    createFakePort({ vaultStatus: async () => vaultStatus({ enabled: false, linked: false }) }),
  )
})
afterEach(cleanup)

describe("К6: the list", () => {
  it("shows only the archive: its files with folders and the time of the move, not the old trash", async () => {
    render(<ArchivePanel {...props} />)
    expect(await screen.findByText("Черновик", {}, FAST)).toBeTruthy()
    expect(screen.getByText("Идея")).toBeTruthy()
    expect(screen.getByText("Мир")).toBeTruthy()
    expect(screen.queryByText("Из корзины")).toBeNull()
    expect(listTrash).not.toHaveBeenCalled()
    const times = Array.from(document.querySelectorAll("time")).map((node) =>
      node.getAttribute("datetime"),
    )
    expect(times).toContain(new Date(draft.archivedAtMs).toISOString())
  })

  it("searches the original path of the archive files", async () => {
    render(<ArchivePanel {...props} />)
    await screen.findByText("Черновик", {}, FAST)
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Идеи/" } })
    expect(screen.getByText("Идея")).toBeTruthy()
    expect(screen.queryByText("Черновик")).toBeNull()
  })

  it("has no cloud mark on a row even when the server list says the file is also there", async () => {
    // К6: "Облачка у строк архива (И11а) больше нет".
    vi.mocked(resolveSyncPort).mockReturnValue(
      createFakePort({
        vaultStatus: async () => vaultStatus(),
        deletedFiles: async () => ({
          available: true,
          reason: null,
          files: [],
          truncated: false,
          trashOnServer: [
            {
              trashId: "arch-1",
              itemId: "01".repeat(16),
              deletedMs: NOW,
              keptUntilMs: NOW + 1e9,
              device: "otherDevice",
              deviceName: "Ноутбук",
            },
          ],
        }),
      }),
    )
    render(<ArchivePanel {...props} />)
    await screen.findByText("Черновик", {}, FAST)
    await screen.findByRole("button", { name: "Облако" }, FAST)
    expect(screen.queryByRole("img", { name: /на сервере/ })).toBeNull()
    expect(screen.queryByText(/есть на сервере/)).toBeNull()
  })

  it("keeps the cloud button that switches to the server list (И9а)", async () => {
    vi.mocked(resolveSyncPort).mockReturnValue(
      createFakePort({
        vaultStatus: async () => vaultStatus(),
        deletedFiles: async () => ({
          available: true,
          reason: null,
          files: [
            {
              itemId: "02".repeat(16),
              path: "Заметки/Удалённая.md",
              sizeBytes: 10,
              deletedMs: NOW - 86_400_000,
              keptUntilMs: NOW + 86_400_000,
              device: "otherDevice",
              deviceName: "Ноутбук",
            },
          ],
          truncated: false,
        }),
      }),
    )
    render(<ArchivePanel {...props} />)
    await screen.findByText("Черновик", {}, FAST)
    fireEvent.click(await screen.findByRole("button", { name: "Облако" }, FAST))
    const part = await screen.findByTestId("archive-server-section", {}, FAST)
    expect(within(part).getByText("Удалённая")).toBeTruthy()
    expect(screen.queryByText("Черновик")).toBeNull()
  })
})

describe("К6: «Вернуть»", () => {
  it("restores by the id of the archive entry, not of the trash", async () => {
    render(<ArchivePanel {...props} />)
    await screen.findByText("Черновик", {}, FAST)
    fireEvent.click(screen.getByRole("button", { name: /Восстановить .*Черновик/ }))
    await waitFor(() => expect(restoreArchive).toHaveBeenCalledWith("arch-1"), FAST)
  })

  it("says the final name when the place was taken and the file came back as «Name 2»", async () => {
    vi.mocked(restoreArchive).mockResolvedValue({
      primaryId: null,
      primaryPath: "/vault/Мир/Черновик 2.md",
      pathChanges: [],
      deletedPaths: [],
    })
    render(<ArchivePanel {...props} />)
    await screen.findByText("Черновик", {}, FAST)
    fireEvent.click(screen.getByRole("button", { name: /Восстановить .*Черновик/ }))
    const line = await screen.findByText(/Черновик 2\.md/, {}, FAST)
    expect(line.closest("[role=status]")).toBeTruthy()
  })

  it("says nothing extra when the file came back under its own name", async () => {
    render(<ArchivePanel {...props} />)
    await screen.findByText("Черновик", {}, FAST)
    fireEvent.click(screen.getByRole("button", { name: /Восстановить .*Черновик/ }))
    await waitFor(() => expect(restoreArchive).toHaveBeenCalled(), FAST)
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull(), FAST)
  })
})

describe("К6, К4: «Удалить из архива» by the setting", () => {
  async function deleteFromMenu() {
    render(<ArchivePanel {...props} />)
    await screen.findByText("Черновик", {}, FAST)
    openActions("Черновик")
    fireEvent.click(await screen.findByRole("menuitem", { name: "Удалить из архива" }, FAST))
  }

  it("names the action «Удалить из архива» and passes the system trash setting", async () => {
    setDeleteMode("system")
    await deleteFromMenu()
    await waitFor(() => expect(purgeArchive).toHaveBeenCalledWith("arch-1", "system"), FAST)
  })

  it("passes «Переносить в архив» as it is: in the archive it means the system trash", async () => {
    setDeleteMode("archive")
    await deleteFromMenu()
    await waitFor(() => expect(purgeArchive).toHaveBeenCalledWith("arch-1", "archive"), FAST)
  })

  it("asks every time and passes permanent only after a yes", async () => {
    setDeleteMode("permanent")
    await deleteFromMenu()
    await waitFor(() => expect(purgeArchive).toHaveBeenCalledWith("arch-1", "permanent"), FAST)
    expect(confirm).toHaveBeenCalled()
    expect(vi.mocked(confirm).mock.calls[0][0].destructive).toBe(true)
  })

  it("deletes nothing when the person says no to a permanent deletion", async () => {
    setDeleteMode("permanent")
    vi.mocked(confirm).mockResolvedValue(false)
    await deleteFromMenu()
    await waitFor(() => expect(confirm).toHaveBeenCalled(), FAST)
    expect(purgeArchive).not.toHaveBeenCalled()
    expect(screen.getByText("Черновик")).toBeTruthy()
  })
})

describe("К11 (в): a refusing system trash", () => {
  it("keeps the row and says «Не удалось удалить» under the button", async () => {
    vi.mocked(purgeArchive).mockRejectedValue(new Error("refused"))
    setDeleteMode("system")
    render(<ArchivePanel {...props} />)
    await screen.findByText("Черновик", {}, FAST)
    openActions("Черновик")
    fireEvent.click(await screen.findByRole("menuitem", { name: "Удалить из архива" }, FAST))
    expect(await screen.findByText(/Не удалось удалить/, {}, FAST)).toBeTruthy()
    expect(screen.getByText("Черновик")).toBeTruthy()
  })
})

describe("К6: the preview", () => {
  it("reads the archived file, not the old trash", async () => {
    vi.mocked(readArchivePreview).mockResolvedValue({
      path: "",
      directory: false,
      text: "Текст из архива",
      children: [],
      truncated: false,
    })
    render(<ArchivePanel {...props} />)
    await screen.findByText("Черновик", {}, FAST)
    fireEvent.click(screen.getByRole("button", { name: "Предпросмотр «Черновик»" }))
    await waitFor(() => expect(readArchivePreview).toHaveBeenCalledWith("arch-1", ""), FAST)
  })
})
