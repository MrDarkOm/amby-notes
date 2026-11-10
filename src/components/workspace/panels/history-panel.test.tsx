// @vitest-environment happy-dom
// The side history panel shows the same cloud marks as the dialog (docs/sync-plan.md, И3а).
import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import { useHistory } from "../history/use-history"
import { HistoryPanel } from "./history-panel"
import type { PanelRenderProps } from "../panel-registry"

vi.mock("../history/use-history", () => ({ useHistory: vi.fn() }))
vi.mock("../history/history-preview", () => ({ HistoryPreview: () => null }))
type History = ReturnType<typeof useHistory>

const at = (day: number, hour: number) => new Date(2026, 10, day, hour).getTime()
const snapshots = [
  { id: "local-new", createdAtMs: at(8, 12), reason: "note-save", sizeBytes: 20 },
  { id: "local-old", createdAtMs: at(2, 12), reason: "note-save", sizeBytes: 20 },
]
const props: PanelRenderProps = {
  treeItems: [],
  selectedId: null,
  vault: "/vault",
  currentDocPath: "/vault/Notes/Заметка.md",
  onSelect: vi.fn(),
  onOpenVault: vi.fn(),
}

function history(server: unknown): History {
  return {
    server,
    selectedServer: null,
    snapshots,
    stats: { snapshotCount: 2, noteCount: 1, sizeBytes: 40 },
    loading: false,
    busy: false,
    error: "",
    notice: "",
    selected: null,
    refresh: vi.fn(),
    select: vi.fn(),
    selectServer: vi.fn(),
    cleanup: vi.fn(),
    clearAll: vi.fn(),
    openLatest: vi.fn(),
  } as unknown as History
}

beforeEach(async () => {
  vi.clearAllMocks()
  await i18n.changeLanguage("ru")
})
afterEach(cleanup)

describe("И3а in the side panel", () => {
  it("marks the matching snapshot with a cloud and the device label", () => {
    vi.mocked(useHistory).mockReturnValue(
      history({
        available: true,
        reason: null,
        versions: [],
        snapshotsOnServer: [
          {
            snapshotId: "local-old",
            version: 2,
            device: "otherDevice",
            deviceName: "Рабочий ноутбук",
            committedMs: at(2, 12),
          },
        ],
      }),
    )
    render(<HistoryPanel {...props} />)
    const marks = screen.getAllByLabelText("Есть на сервере")
    expect(marks).toHaveLength(1)
    const row = marks[0].closest("button") as HTMLElement
    expect(within(row).getByText(/Рабочий ноутбук/)).toBeTruthy()
  })

  it("shows the calm top line when the current text is saved on the server", () => {
    vi.mocked(useHistory).mockReturnValue(
      history({ available: true, reason: null, versions: [], currentOnServer: true }),
    )
    render(<HistoryPanel {...props} />)
    expect(screen.getByTestId("history-current-on-server").textContent).toBe(
      "Текущий текст сохранён на сервере",
    )
  })

  it("shows nothing without the server part", () => {
    vi.mocked(useHistory).mockReturnValue(
      history({
        available: false,
        reason: "syncOff",
        versions: [],
        currentOnServer: true,
        snapshotsOnServer: [
          { snapshotId: "local-old", version: 1, device: "thisDevice", committedMs: 1 },
        ],
      }),
    )
    render(<HistoryPanel {...props} />)
    expect(screen.queryByLabelText("Есть на сервере")).toBeNull()
    expect(screen.queryByTestId("history-current-on-server")).toBeNull()
  })
})
