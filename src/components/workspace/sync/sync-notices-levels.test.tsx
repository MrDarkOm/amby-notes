// @vitest-environment happy-dom
// The toasts, the limits and the badge of the sync host have a level of docs/notices.md (section 2.1)
// and are drawn by it (step 1 of the transition): a note that came back is information, a conflict is a
// decision, a limit of the plan is a warning. Where they stand and when they go stays as it was.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { listTrash, restoreTrash } from "@/lib/storage"
import { useNoteNoticesStore } from "../note-notices/use-note-notices-store"
import { useDocStore } from "../use-doc-store"
import { useVaultStore } from "../use-vault-store"
import { SyncNoticesHost } from "./sync-notices-host"
import { NoticesDock } from "./dock-test-harness"
import { useSyncNoticesStore } from "./use-sync-notices-store"
import {
  createFakePort,
  emitRestoredAfterDeletion,
  emitVaultStatus,
  vaultStatus,
} from "./fake-sync-port"

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  listTrash: vi.fn(),
  restoreTrash: vi.fn(),
}))

const ORIGINAL = "Заметки/идея.md"
const conflict = {
  id: "0123456789ab",
  kind: "bothEdited",
  originalPath: ORIGINAL,
  copyPath: "Заметки/идея.0123456789ab-conflict.md",
  createdMs: 1_760_000_000_000,
}

async function mount(status = vaultStatus()) {
  const port = createFakePort({ vaultStatus: async () => status })
  render(
    <>
      <SyncNoticesHost port={port} />
      <NoticesDock />
    </>,
  )
  await waitFor(() => expect(port.vaultStatus).toHaveBeenCalled())
  return port
}

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  useVaultStore.setState({ vault: "/vault" })
  useDocStore.setState({ openDocs: {}, externalConflicts: {} })
  useSyncNoticesStore.setState(useSyncNoticesStore.getInitialState())
  useNoteNoticesStore.setState({ restored: [] })
  vi.mocked(listTrash).mockResolvedValue([])
  vi.mocked(restoreTrash).mockResolvedValue({ changed: [] } as never)
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("the level of the toasts of the sync host", () => {
  it("a note that came back after a deletion is information, not a triangle", async () => {
    await mount()
    await act(async () => emitRestoredAfterDeletion([ORIGINAL]))
    const toast = await screen.findByRole("status")
    expect(toast.getAttribute("data-level")).toBe("info")
    expect(toast.querySelector("svg.lucide-info")).not.toBeNull()
    expect(toast.querySelector("svg.lucide-triangle-alert")).toBeNull()
  })

  it("a new conflict is a decision", async () => {
    await mount()
    await act(async () => emitVaultStatus(vaultStatus({ conflicts: [conflict] })))
    const toast = await screen.findByRole("status")
    expect(toast.textContent).toMatch(/Конфликт синхронизации/)
    expect(toast.getAttribute("data-level")).toBe("decision")
    expect(toast.querySelector("svg.lucide-triangle-alert")).not.toBeNull()
  })

  it("the number on the dock button is a decision for a conflict, and no floating badge is left", async () => {
    await mount(vaultStatus({ conflicts: [conflict] }))
    const count = await screen.findByTestId("notices-dock-count")
    expect(count.getAttribute("data-level")).toBe("decision")
    expect(count.getAttribute("class")).toContain("--notice-decision-")
    expect(count.getAttribute("class")).not.toMatch(/amber/)
    expect(screen.queryByTestId("sync-conflict-badge")).toBeNull()
  })

  it("the files over the limit, and the full storage, are warnings", async () => {
    await mount()
    await act(async () =>
      emitVaultStatus(
        vaultStatus({
          unsynced: [
            {
              path: "a.bin",
              reason: "tooLarge",
              detail: null,
              maxBytes: 20_000_000,
              limitSource: "plan",
            },
            { path: "b.bin", reason: "quotaFull", detail: null },
          ],
        }),
      ),
    )
    const cards = await screen.findAllByTestId("sync-limit-notice")
    expect(cards).toHaveLength(2)
    for (const card of cards) {
      expect(card.getAttribute("data-level")).toBe("warning")
      expect(card.getAttribute("role")).toBe("status")
      expect(card.querySelector("svg.lucide-circle-alert")).not.toBeNull()
    }
  })

  it("no toast keeps an amber class", async () => {
    await mount()
    await act(async () => emitRestoredAfterDeletion([ORIGINAL]))
    await act(async () =>
      emitVaultStatus(
        vaultStatus({
          conflicts: [conflict],
          unsynced: [{ path: "b.bin", reason: "quotaFull", detail: null }],
        }),
      ),
    )
    await screen.findByTestId("notices-dock-count")
    expect(document.body.innerHTML).not.toMatch(/amber/)
  })
})
