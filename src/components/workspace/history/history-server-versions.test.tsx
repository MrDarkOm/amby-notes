// @vitest-environment happy-dom
// Earlier versions from the server in the history panel of a note (docs/sync-plan.md, appendix И,
// И1, И2-г, И4, И5, И6, И20). Red until the panel shows them (раздел 6). The rows carry
// `data-testid="history-row"` with `data-source="local" | "server"`, the cloud mark is the element
// labelled "Версия с сервера", and the answer to "Вернуть" is the element `history-restore-result`
// that follows the button.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import type { NoteServerVersions, ServerVersionView } from "@/lib/sync/sync-port"
import { useHistory } from "./use-history"
import { HistoryPreview } from "./history-preview"

vi.mock("./use-history", () => ({ useHistory: vi.fn() }))
type History = ReturnType<typeof useHistory>

const at = (day: number, hour: number) => new Date(2026, 10, day, hour).getTime()

const snapshots = [
  { id: "local-new", createdAtMs: at(8, 12), reason: "note-save", sizeBytes: 20 },
  { id: "local-old", createdAtMs: at(2, 12), reason: "note-save", sizeBytes: 20 },
]

function serverVersion(overrides: Partial<ServerVersionView> = {}): ServerVersionView {
  return {
    itemId: "a1".repeat(16),
    version: 3,
    path: "Notes/Заметка.md",
    sizeBytes: 40,
    contentHash: "b2".repeat(32),
    committedMs: at(5, 12),
    device: "otherDevice",
    deviceName: "Рабочий ноутбук",
    ...overrides,
  }
}

function server(versions: ServerVersionView[]): NoteServerVersions {
  return { available: true, reason: null, versions }
}

function history(overrides: Partial<History> = {}): History {
  return {
    server: server([]),
    selectedServer: null,
    serverPreview: null,
    serverRestoreStatus: null,
    selectServer: vi.fn(),
    restoreServer: vi.fn(),
    snapshots,
    stats: { snapshotCount: 2, noteCount: 1, sizeBytes: 40 },
    loading: false,
    busy: false,
    error: "",
    notice: "",
    selected: snapshots[0],
    preview: { previous: "# Было\n", current: "# Стало\n" },
    previewLoading: false,
    refresh: vi.fn(),
    select: vi.fn(),
    restore: vi.fn(),
    cleanup: vi.fn(),
    removeSnapshot: vi.fn(),
    clearAll: vi.fn(),
    openLatest: vi.fn(),
    ...overrides,
  } as unknown as History
}

function show(state: History) {
  vi.mocked(useHistory).mockReturnValue(state)
  return render(
    <HistoryPreview history={state} name="Заметка" path="/vault/Notes/Заметка.md" treeItems={[]} />,
  )
}

const rows = () => screen.queryAllByTestId("history-row")

beforeEach(async () => {
  vi.clearAllMocks()
  await i18n.changeLanguage("ru")
})
afterEach(cleanup)

describe("И1: one list of local snapshots and versions from the server", () => {
  it("marks a version from the server with a cloud and tells the device", async () => {
    show(
      history({
        server: server([
          serverVersion({ version: 3, device: "otherDevice", deviceName: "Рабочий ноутбук" }),
          serverVersion({ version: 2, device: "thisDevice", deviceName: null }),
          serverVersion({ version: 1, device: "otherDevice", deviceName: null }),
        ]),
      }),
    )
    const serverRows = rows().filter((row) => row.getAttribute("data-source") === "server")
    expect(serverRows).toHaveLength(3)
    for (const row of serverRows) {
      expect(within(row).getByLabelText("Версия с сервера")).toBeTruthy()
    }
    expect(within(serverRows[0]).getByText(/Рабочий ноутбук/)).toBeTruthy()
    expect(within(serverRows[1]).getByText("Этот компьютер")).toBeTruthy()
    expect(within(serverRows[2]).getByText("Другое устройство")).toBeTruthy()
  })

  it("does not mark local snapshots with a cloud", () => {
    show(history({ server: server([serverVersion()]) }))
    const local = rows().filter((row) => row.getAttribute("data-source") === "local")
    expect(local).toHaveLength(2)
    for (const row of local) expect(within(row).queryByLabelText("Версия с сервера")).toBeNull()
  })

  it("puts snapshots and server versions in one list by time, newest first", () => {
    show(
      history({
        server: server([
          serverVersion({ version: 4, committedMs: at(10, 9) }),
          serverVersion({ version: 3, committedMs: at(5, 12) }),
          serverVersion({ version: 2, committedMs: at(1, 12) }),
        ]),
      }),
    )
    expect(rows().map((row) => row.getAttribute("data-source"))).toEqual([
      "server", // 10 Nov
      "local", //   8 Nov
      "server", //  5 Nov
      "local", //   2 Nov
      "server", //  1 Nov
    ])
  })

  it("selects a server version when its row is pressed", () => {
    const state = history({ server: server([serverVersion({ version: 3 })]) })
    show(state)
    const row = rows().find((item) => item.getAttribute("data-source") === "server")
    expect(row).toBeTruthy()
    fireEvent.click(within(row as HTMLElement).getByRole("button"))
    expect(state.selectServer).toHaveBeenCalledWith(expect.objectContaining({ version: 3 }))
    expect(state.select).not.toHaveBeenCalled()
  })
})

describe("И2-г: a renamed note", () => {
  it("says under which earlier name an older version was saved", () => {
    show(
      history({
        server: server([
          serverVersion({ version: 2, path: "Notes/Заметка.md" }),
          serverVersion({ version: 1, path: "Notes/Старое имя.md" }),
        ]),
      }),
    )
    expect(screen.getByText("называлась Notes/Старое имя.md")).toBeTruthy()
    expect(screen.queryByText("называлась Notes/Заметка.md")).toBeNull()
  })
})

describe("И4: no server part", () => {
  it("shows one calm line when sync is off, keeps the snapshots and raises no alert", () => {
    show(history({ server: { available: false, reason: "syncOff", versions: [] } }))
    expect(screen.getByText("Версии с сервера появятся, когда синхронизация включена")).toBeTruthy()
    expect(rows().filter((row) => row.getAttribute("data-source") === "local")).toHaveLength(2)
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("shows the other line when there is no connection", () => {
    show(history({ server: { available: false, reason: "offline", versions: [] } }))
    expect(screen.getByText("Версии с сервера появятся, когда будет связь")).toBeTruthy()
    expect(screen.queryByText("Версии с сервера появятся, когда синхронизация включена")).toBeNull()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("shows the line at the end of the list, after the last row", () => {
    show(history({ server: { available: false, reason: "offline", versions: [] } }))
    const last = rows()[rows().length - 1]
    expect(last).toBeTruthy()
    const line = screen.getByText("Версии с сервера появятся, когда будет связь")
    expect(
      (last as HTMLElement).compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it("shows no line when the server part is there", () => {
    show(history({ server: server([serverVersion()]) }))
    expect(rows().filter((row) => row.getAttribute("data-source") === "server")).toHaveLength(1)
    expect(screen.queryByText(/Версии с сервера появятся/)).toBeNull()
  })

  it("says the same in English", async () => {
    await i18n.changeLanguage("en")
    show(history({ server: { available: false, reason: "offline", versions: [] } }))
    expect(screen.getByText("Server versions will appear when there is a connection")).toBeTruthy()
  })
})

describe("И5: a version that cannot be shown", () => {
  it("says a damaged version is damaged and offers no restore", () => {
    const damaged = serverVersion({ version: 2 })
    show(
      history({
        server: server([damaged]),
        selected: null,
        selectedServer: damaged,
        serverPreview: "damaged",
        preview: null,
      }),
    )
    expect(screen.getByText("Версия повреждена: показать и вернуть её нельзя")).toBeTruthy()
    expect(
      (screen.getByRole("button", { name: "Восстановить версию" }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it("says a too large file is too large to preview", () => {
    const huge = serverVersion({ version: 2, sizeBytes: 300 * 1024 * 1024 })
    show(
      history({
        server: server([huge]),
        selected: null,
        selectedServer: huge,
        serverPreview: "tooLarge",
        preview: null,
      }),
    )
    expect(screen.getByText("Слишком большой файл для просмотра")).toBeTruthy()
  })
})

describe("И6, И17, И20: the restore button and the answer under it", () => {
  const chosen = serverVersion({ version: 2 })
  const withChoice = (overrides: Partial<History> = {}) =>
    history({
      server: server([chosen]),
      selected: null,
      selectedServer: chosen,
      serverPreview: "ok",
      preview: { previous: "# С сервера\n", current: "# Сейчас\n" },
      ...overrides,
    })
  const restoreButton = () => screen.getByRole("button", { name: "Восстановить версию" })

  it("restores the chosen server version, not a snapshot", () => {
    const state = withChoice()
    show(state)
    fireEvent.click(restoreButton())
    expect(state.restoreServer).toHaveBeenCalledWith(expect.objectContaining({ version: 2 }))
    expect(state.restore).not.toHaveBeenCalled()
  })

  it("writes 'the note changed, the list was updated' under the button, not as an alert", () => {
    show(withChoice({ serverRestoreStatus: "noteChanged" }))
    const line = screen.getByTestId("history-restore-result")
    expect(line.textContent).toBe("Заметка изменилась, список обновлён")
    expect(
      restoreButton().compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("writes the answer for a lost connection under the button", () => {
    show(withChoice({ serverRestoreStatus: "offline" }))
    expect(screen.getByTestId("history-restore-result").textContent).toBe(
      "Нет связи с сервером, версия не возвращена",
    )
  })

  it("writes the answer for a damaged version under the button", () => {
    show(withChoice({ serverRestoreStatus: "damaged" }))
    expect(screen.getByTestId("history-restore-result").textContent).toBe(
      "Версия повреждена: показать и вернуть её нельзя",
    )
  })

  it("writes no answer before anything was restored", () => {
    show(withChoice())
    expect(restoreButton()).toBeTruthy()
    expect(screen.queryByTestId("history-restore-result")).toBeNull()
  })
})
