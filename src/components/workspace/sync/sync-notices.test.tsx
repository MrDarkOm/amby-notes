// @vitest-environment happy-dom
// Conflicts of sync made visible (docs/sync-plan.md, Р7, Р8): a badge with a list, a short notice,
// a strip in the note, a side-by-side comparison, and the warning about a note deleted on another
// computer that was open at that moment. Behaviour only; how it looks is checked in a native window.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { listTrash, readFile, restoreTrash } from "@/lib/storage"
import type { Document } from "../use-doc-store"
import { useDocStore } from "../use-doc-store"
import { useVaultStore } from "../use-vault-store"
import {
  createFakePort,
  emitRemoteDeleted,
  emitRestoredAfterDeletion,
  emitVaultStatus,
  vaultStatus,
} from "./fake-sync-port"
import { SyncDocumentBanners } from "./sync-document-banners"
import { SyncNoticesHost } from "./sync-notices-host"
import { useSyncNoticesStore } from "./use-sync-notices-store"

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  readFile: vi.fn(),
  listTrash: vi.fn(),
  restoreTrash: vi.fn(),
}))

const ORIGINAL = "Заметки/идея.md"
const COPY = "Заметки/идея.0123456789ab-conflict.md"
const conflict = {
  id: "0123456789ab",
  kind: "bothEdited",
  originalPath: ORIGINAL,
  copyPath: COPY,
  createdMs: 1_760_000_000_000,
}

const doc = (path: string): Document => ({
  id: path,
  title: "идея",
  content: "текст",
  created: "",
  modified: "",
  wordCount: 1,
  path,
  source: "текст",
})

async function mount(status = vaultStatus()) {
  const port = createFakePort({ vaultStatus: async () => status })
  const view = render(<SyncNoticesHost port={port} />)
  await waitFor(() => expect(port.vaultStatus).toHaveBeenCalled())
  return { port, ...view }
}

const pushStatus = async (status: ReturnType<typeof vaultStatus>) => {
  await act(async () => emitVaultStatus(status))
}

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  useVaultStore.setState({ vault: "/vault" })
  useDocStore.setState({ openDocs: {}, externalConflicts: {} })
  useSyncNoticesStore.setState(useSyncNoticesStore.getInitialState())
  vi.mocked(readFile).mockImplementation(async (path: string) =>
    path.endsWith("-conflict.md") ? "версия с другого компьютера" : "основная версия",
  )
  vi.mocked(listTrash).mockResolvedValue([])
  vi.mocked(restoreTrash).mockResolvedValue({ changed: [] } as never)
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("the badge and the list of conflicts", () => {
  it("shows nothing while there is no conflict", async () => {
    await mount()
    expect(screen.queryByTestId("sync-conflict-badge")).toBeNull()
  })

  it("shows a badge with the number of conflicts, and the list on a click", async () => {
    await mount(vaultStatus({ conflicts: [conflict, { ...conflict, id: "ba9876543210" }] }))
    const badge = await screen.findByTestId("sync-conflict-badge")
    expect(badge.textContent).toContain("2")
    expect(badge.getAttribute("aria-label")).toMatch(/Конфликты синхронизации/)
    expect(screen.queryByTestId("sync-conflicts")).toBeNull()
    fireEvent.click(badge)
    const list = await screen.findByTestId("sync-conflicts")
    expect(within(list).getAllByRole("listitem")).toHaveLength(2)
    expect(list.textContent).toMatch(/идея\.0123456789ab-conflict\.md/)
  })

  it("takes the badge away once the conflict is resolved", async () => {
    await mount(vaultStatus({ conflicts: [conflict] }))
    await screen.findByTestId("sync-conflict-badge")
    await pushStatus(vaultStatus({ conflicts: [] }))
    await waitFor(() => expect(screen.queryByTestId("sync-conflict-badge")).toBeNull())
  })

  it("resolves from the list with the existing command", async () => {
    const { port } = await mount(vaultStatus({ conflicts: [conflict] }))
    fireEvent.click(await screen.findByTestId("sync-conflict-badge"))
    fireEvent.click(await screen.findByRole("button", { name: "Оставить основной файл" }))
    await waitFor(() =>
      expect(port.resolveConflict).toHaveBeenCalledWith("0123456789ab", "keepOriginal"),
    )
  })
})

describe("the notice about a new conflict", () => {
  it("appears when a conflict appears, once", async () => {
    await mount()
    await pushStatus(vaultStatus({ conflicts: [conflict] }))
    const notice = await screen.findByRole("status")
    expect(notice.textContent).toMatch(/Конфликт синхронизации/)
    expect(notice.textContent).toMatch(/идея/)
    await pushStatus(vaultStatus({ conflicts: [conflict], lastSyncMs: 1_760_000_999_000 }))
    expect(screen.getAllByRole("status")).toHaveLength(1)
  })

  it("is not shown for a conflict that was already there when the screen opened", async () => {
    await mount(vaultStatus({ conflicts: [conflict] }))
    await screen.findByTestId("sync-conflict-badge")
    expect(screen.queryByRole("status")).toBeNull()
  })
})

describe("the notice about a note brought back after a deletion made here", () => {
  it("is shown even when the note is not open, and names it", async () => {
    await mount()
    await act(async () => emitRestoredAfterDeletion([ORIGINAL]))
    const notice = await screen.findByRole("status")
    expect(notice.textContent).toMatch(/Заметку «идея» вернули/)
    expect(notice.textContent).toMatch(/правили на другом компьютере/)
    expect(useDocStore.getState().openDocs).toEqual({})
  })
})

describe("the strip in a note that has a second version", () => {
  const strip = /У этой заметки есть вторая версия с другого компьютера/

  it("is shown in the main file and in the copy, and not in another note", async () => {
    await mount(vaultStatus({ conflicts: [conflict] }))
    const { rerender } = render(<SyncDocumentBanners path={`/vault/${ORIGINAL}`} />)
    expect(await screen.findByText(strip)).toBeTruthy()
    rerender(<SyncDocumentBanners path={`/vault/${COPY}`} />)
    expect(await screen.findByText(strip)).toBeTruthy()
    rerender(<SyncDocumentBanners path="/vault/Заметки/другая.md" />)
    expect(screen.queryByText(strip)).toBeNull()
  })

  it("goes away when the conflict is resolved", async () => {
    await mount(vaultStatus({ conflicts: [conflict] }))
    render(<SyncDocumentBanners path={`/vault/${ORIGINAL}`} />)
    await screen.findByText(strip)
    await pushStatus(vaultStatus({ conflicts: [] }))
    await waitFor(() => expect(screen.queryByText(strip)).toBeNull())
  })
})

describe("the comparison of the two versions", () => {
  async function openFromStrip() {
    const view = await mount(vaultStatus({ conflicts: [conflict] }))
    render(<SyncDocumentBanners path={`/vault/${COPY}`} />)
    fireEvent.click(await screen.findByRole("button", { name: "Сравнить" }))
    const dialog = await screen.findByRole("dialog")
    return { ...view, dialog }
  }

  it("opens from the strip and shows both versions side by side", async () => {
    const { dialog } = await openFromStrip()
    await waitFor(() => expect(within(dialog).getByText("основная версия")).toBeTruthy())
    expect(within(dialog).getByText("версия с другого компьютера")).toBeTruthy()
    expect(vi.mocked(readFile)).toHaveBeenCalledWith(`/vault/${ORIGINAL}`)
    expect(vi.mocked(readFile)).toHaveBeenCalledWith(`/vault/${COPY}`)
  })

  it("opens from the list too", async () => {
    await mount(vaultStatus({ conflicts: [conflict] }))
    fireEvent.click(await screen.findByTestId("sync-conflict-badge"))
    fireEvent.click(await screen.findByRole("button", { name: "Сравнить" }))
    expect(await screen.findByRole("dialog")).toBeTruthy()
  })

  it.each([
    ["Оставить основной файл", "keepOriginal"],
    ["Заменить копией", "keepCopy"],
    ["Оставить оба", "keepBoth"],
  ])("offers “%s” and resolves the conflict with the existing command", async (label, choice) => {
    const { port, dialog } = await openFromStrip()
    fireEvent.click(within(dialog).getByRole("button", { name: label }))
    await waitFor(() => expect(port.resolveConflict).toHaveBeenCalledWith("0123456789ab", choice))
  })

  it("closes once the conflict has left the list", async () => {
    await openFromStrip()
    await pushStatus(vaultStatus({ conflicts: [] }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })
})

describe("a note deleted on another computer", () => {
  const message = /Эту заметку удалили на другом компьютере\. Она в архиве хранилища/

  it("is announced when that note is open, with a way back", async () => {
    useDocStore.setState({ openDocs: { a: doc(`/vault/${ORIGINAL}`) } })
    await mount()
    render(<SyncDocumentBanners path={`/vault/${ORIGINAL}`} />)
    expect(screen.queryByText(message)).toBeNull()
    await act(async () => emitRemoteDeleted([ORIGINAL]))
    expect(await screen.findByText(message)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Вернуть" })).toBeTruthy()
  })

  it("ignores an announcement that belongs to the vault it left behind", async () => {
    // a late event of the previous vault must not mark the note of the same name in this one
    useDocStore.setState({ openDocs: { a: doc(`/vault/${ORIGINAL}`) } })
    await mount()
    render(<SyncDocumentBanners path={`/vault/${ORIGINAL}`} />)
    await act(async () => emitRemoteDeleted([ORIGINAL], "/old-vault"))
    expect(screen.queryByText(message)).toBeNull()
    expect(useSyncNoticesStore.getState().remoteDeleted).toEqual([])
    expect(useDocStore.getState().openDocs.a?.externallyDeleted).toBeFalsy()
  })

  it("says nothing when the note was not open", async () => {
    useDocStore.setState({ openDocs: { a: doc("/vault/Заметки/другая.md") } })
    await mount()
    render(<SyncDocumentBanners path={`/vault/${ORIGINAL}`} />)
    await act(async () => emitRemoteDeleted([ORIGINAL]))
    expect(screen.queryByText(message)).toBeNull()
    expect(screen.queryByRole("status")).toBeNull()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("brings the file back from the archive of the vault", async () => {
    useDocStore.setState({ openDocs: { a: doc(`/vault/${ORIGINAL}`) } })
    vi.mocked(listTrash).mockResolvedValue([
      { id: "t0", originalPath: "/vault/Заметки/старая.md", deletedAtMs: 1, name: "старая" },
      { id: "t1", originalPath: `/vault/${ORIGINAL}`, deletedAtMs: 2, name: "идея" },
    ])
    await mount()
    render(<SyncDocumentBanners path={`/vault/${ORIGINAL}`} />)
    await act(async () => emitRemoteDeleted([ORIGINAL]))
    fireEvent.click(await screen.findByRole("button", { name: "Вернуть" }))
    await waitFor(() => expect(restoreTrash).toHaveBeenCalledWith("t1"))
    await waitFor(() => expect(screen.queryByText(message)).toBeNull())
  })

  it("keeps the message and shows an error when the archive does not have it", async () => {
    useDocStore.setState({ openDocs: { a: doc(`/vault/${ORIGINAL}`) } })
    await mount()
    render(<SyncDocumentBanners path={`/vault/${ORIGINAL}`} />)
    await act(async () => emitRemoteDeleted([ORIGINAL]))
    fireEvent.click(await screen.findByRole("button", { name: "Вернуть" }))
    expect(await screen.findByRole("alert")).toBeTruthy()
    expect(restoreTrash).not.toHaveBeenCalled()
    expect(screen.getByText(message)).toBeTruthy()
  })
})
