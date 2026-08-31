// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import { HistoryPanel } from "@/components/workspace/panels/history-panel"
import { useHistory } from "@/components/workspace/history/use-history"
import { useVaultStore } from "@/components/workspace/use-vault-store"
import { useDocStore } from "@/components/workspace/use-doc-store"
import { flushAutosaveGeneration } from "@/components/workspace/autosave/autosave-lifecycle"
import * as storage from "@/lib/storage"

vi.mock("@/lib/storage", async (original) => ({
  ...(await original<typeof import("@/lib/storage")>()),
  listSnapshots: vi.fn(),
  listTrash: vi.fn(),
  getHistoryStats: vi.fn(),
  readSnapshotText: vi.fn(),
  readFile: vi.fn(),
  confirmAction: vi.fn(),
  restoreSnapshot: vi.fn(),
  restoreTrash: vi.fn(),
  previewHistoryCleanup: vi.fn(),
  cleanupHistory: vi.fn(),
}))
vi.mock("@/components/workspace/autosave/autosave-lifecycle", () => ({
  flushAutosaveGeneration: vi.fn(),
}))
const entries = Array.from({ length: 52 }, (_, i) => ({
  id: `snapshot-${i}`,
  createdAtMs: new Date(2026, 7, 31, 9, 0).getTime() - i * 600_000,
  reason: i === 5 ? "restore" : "note-save",
  sizeBytes: 200,
}))
const props = {
  treeItems: [],
  selectedId: "note",
  vault: "/vault",
  currentDocPath: "/vault/Note.md",
  onSelect: vi.fn(),
  onOpenVault: vi.fn(),
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
beforeEach(() => {
  vi.resetAllMocks()
  useVaultStore.setState({ ...useVaultStore.getInitialState(), vault: "/vault" })
  useDocStore.getState().clearDocs()
  vi.mocked(storage.listSnapshots).mockResolvedValue(entries)
  vi.mocked(storage.listTrash).mockResolvedValue([
    {
      id: "trash-1",
      name: "Deleted.md",
      originalPath: "/vault/Deleted.md",
      deletedAtMs: entries[0].createdAtMs,
    },
  ])
  vi.mocked(storage.getHistoryStats).mockResolvedValue({
    snapshotCount: 52,
    noteCount: 1,
    sizeBytes: 10400,
  })
  vi.mocked(storage.readSnapshotText).mockResolvedValue({
    sourcePath: props.currentDocPath,
    content: "before\n",
  })
  vi.mocked(storage.readFile).mockResolvedValue("after\n")
  vi.mocked(storage.confirmAction).mockResolvedValue(true)
  vi.mocked(storage.restoreSnapshot).mockResolvedValue(props.currentDocPath)
  vi.mocked(flushAutosaveGeneration).mockResolvedValue({ flushed: true, participants: 1 })
})
afterEach(cleanup)

describe("history interface", () => {
  it("paginates and searches versions, previews real changes, and separates the trash", async () => {
    render(<HistoryPanel {...props} />)
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /Посмотреть версию/ })).toHaveLength(40),
    )
    expect(screen.queryByText("note-save")).toBeNull()
    expect(screen.queryByText("Deleted.md")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /Показать ещё/ }))
    expect(screen.getAllByRole("button", { name: /Посмотреть версию/ })).toHaveLength(52)
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "восстановлением" } })
    expect(screen.getAllByRole("button", { name: /Посмотреть версию/ })).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: /Посмотреть версию/ }))
    const dialog = await screen.findByRole("dialog")
    await waitFor(() => expect(within(dialog).getByText("before")).toBeTruthy())
    expect(within(dialog).getByText("after")).toBeTruthy()
    expect(within(dialog).getByText("+1 строка")).toBeTruthy()
    expect(storage.restoreSnapshot).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole("button", { name: "Закрыть" }))
    fireEvent.click(screen.getByRole("button", { name: /Корзина/ }))
    expect(screen.getByText("Deleted.md")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Посмотреть версию/ })).toBeNull()
  })
  it("discards an old note response after switching notes", async () => {
    const old = deferred<storage.SnapshotEntry[]>()
    vi.mocked(storage.listSnapshots)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce([{ ...entries[0], id: "new-note", reason: "link-refactor" }])
    const view = render(<HistoryPanel {...props} />)
    view.rerender(<HistoryPanel {...props} currentDocPath="/vault/Other.md" />)
    await screen.findByText("Обновление ссылок")
    await act(async () => old.resolve(entries))
    expect(screen.getAllByRole("button", { name: /Посмотреть версию/ })).toHaveLength(1)
    expect(screen.queryByText("Автосохранение")).toBeNull()
  })
})

describe("history operations", () => {
  it("ignores a slower preview when another version is selected", async () => {
    const old = deferred<storage.SnapshotText>()
    vi.mocked(storage.readSnapshotText).mockReturnValueOnce(old.promise)
    const hook = renderHook(() => useHistory(props.currentDocPath))
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    let pending!: Promise<void>
    act(() => {
      pending = hook.result.current.select(entries[0])
    })
    await act(() => hook.result.current.select(entries[1]))
    await act(async () => {
      old.resolve({ sourcePath: props.currentDocPath, content: "stale" })
      await pending
    })
    expect(hook.result.current.selected?.id).toBe(entries[1].id)
    expect(hook.result.current.preview?.previous).toBe("before\n")
  })
  it("preserves the original when autosave cannot flush", async () => {
    vi.mocked(flushAutosaveGeneration).mockResolvedValue({ flushed: false, participants: 1 })
    const hook = renderHook(() => useHistory(props.currentDocPath))
    await act(() => hook.result.current.restore(entries[0]))
    expect(storage.restoreSnapshot).not.toHaveBeenCalled()
    expect(hook.result.current.error).toMatch(/сохраните текущие правки/)
  })
  it("blocks restore if the target has an unresolved external conflict", async () => {
    useDocStore.getState().setDoc("note", {
      id: "note",
      path: props.currentDocPath,
      title: "Note",
      content: "local",
      source: "local",
      created: "",
      modified: "",
      wordCount: 1,
    })
    useDocStore.getState().setExternalConflict({
      fileId: "note",
      path: props.currentDocPath,
      localContent: "local",
      externalContent: "external",
    })
    const hook = renderHook(() => useHistory(props.currentDocPath))
    await act(() => hook.result.current.restore(entries[0]))
    expect(storage.restoreSnapshot).not.toHaveBeenCalled()
    expect(useDocStore.getState().openDocs.note.content).toBe("local")
  })
  it("flushes before restoring, then reloads the workspace and versions", async () => {
    const onRestored = vi.fn(async () => {})
    const hook = renderHook(() => useHistory(props.currentDocPath, onRestored))
    await act(() => hook.result.current.restore(entries[0]))
    expect(storage.restoreSnapshot).toHaveBeenCalledWith(entries[0].id)
    expect(vi.mocked(flushAutosaveGeneration).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(storage.restoreSnapshot).mock.invocationCallOrder[0],
    )
    expect(onRestored).toHaveBeenCalledTimes(1)
    expect(hook.result.current.notice).toMatch(/Версия восстановлена/)
  })
  it("does not restore after the user cancels or the vault changes during confirmation", async () => {
    const confirmation = deferred<boolean>()
    vi.mocked(storage.confirmAction).mockReturnValue(confirmation.promise)
    const hook = renderHook(() => useHistory(props.currentDocPath))
    let pending!: Promise<void>
    act(() => {
      pending = hook.result.current.restore(entries[0])
    })
    act(() => useVaultStore.getState().setVault("/another"))
    await act(async () => {
      confirmation.resolve(true)
      await pending
    })
    expect(storage.restoreSnapshot).not.toHaveBeenCalled()
    vi.mocked(storage.confirmAction).mockResolvedValue(false)
    await act(() => hook.result.current.restore(entries[0]))
    expect(storage.restoreSnapshot).not.toHaveBeenCalled()
  })
  it("previews cleanup, respects cancellation, and reports when nothing can be removed", async () => {
    const remaining = { snapshotCount: 20, noteCount: 1, sizeBytes: 4000 }
    vi.mocked(storage.previewHistoryCleanup).mockResolvedValue({
      removedCount: 32,
      freedBytes: 6400,
      remaining,
    })
    vi.mocked(storage.confirmAction).mockResolvedValue(false)
    const hook = renderHook(() => useHistory(props.currentDocPath))
    await act(() => hook.result.current.cleanup())
    expect(storage.confirmAction).toHaveBeenCalledWith(expect.stringContaining("32"))
    expect(storage.cleanupHistory).not.toHaveBeenCalled()
    vi.mocked(storage.previewHistoryCleanup).mockResolvedValue({
      removedCount: 0,
      freedBytes: 0,
      remaining,
    })
    await act(() => hook.result.current.cleanup())
    expect(hook.result.current.notice).toMatch(/для очистки нет/)
  })
  it("shows load and preview errors without leaving a spinner or enabling restoration", async () => {
    vi.mocked(storage.listSnapshots).mockRejectedValue(new Error("unavailable"))
    const hook = renderHook(() => useHistory(props.currentDocPath))
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    expect(hook.result.current.error).toMatch(/Не удалось загрузить/)
    vi.mocked(storage.readSnapshotText).mockRejectedValue(new Error("corrupt"))
    await act(() => hook.result.current.select(entries[0]))
    expect(hook.result.current.previewLoading).toBe(false)
    expect(hook.result.current.preview).toBeNull()
    expect(hook.result.current.error).toMatch(/Не удалось прочитать/)
  })
})
