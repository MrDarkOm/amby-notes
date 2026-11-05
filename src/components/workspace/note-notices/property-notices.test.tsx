// @vitest-environment happy-dom
// The warnings of the properties of a note are cards in the stack above the bottom bar, not blocks in
// the panel (docs/sync-plan.md, К3): the offer of the new format, the hint about a rename, what was
// carried over from an old version, the choice after an edit made in both places, the warning about
// an old version and the notes about the file of the properties.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import i18n from "@/lib/i18n"
import type { PropertyPanel, PropertyStorageStatus } from "@/lib/properties/property-groups-port"
import { useVaultStore } from "../use-vault-store"

const port = vi.hoisted(() => ({
  propertyStorageStatus: vi.fn(),
  getPropertyPanel: vi.fn(),
  acceptPropertyRenameHint: vi.fn(),
  dismissPropertyRenameHint: vi.fn(),
  previewPropertiesMigration: vi.fn(),
  runPropertiesMigration: vi.fn(),
  checkOldVersionPropertyEdits: vi.fn(),
  resolveOldVersionPropertyConflict: vi.fn(),
}))
vi.mock("@/lib/properties/property-groups-port", () => port)

import { NoteNotices } from "./note-notices"

const panel = (overrides: Partial<PropertyPanel> = {}): PropertyPanel => ({
  unreadable: false,
  active: [],
  dormant: [],
  renameHint: null,
  warnings: [],
  ...overrides,
})
const groups: PropertyStorageStatus = { mode: "groups", oldVersionWarning: null }

function mount() {
  return render(
    <NoteNotices document={{ id: "N1", path: "/vault/Заметка.md" }} warningKey={null} />,
  )
}
const open = async () => {
  fireEvent.click(await screen.findByTestId("note-notices-bulb"))
}

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  useVaultStore.setState({ vault: "/vault" })
  port.getPropertyPanel.mockResolvedValue(panel())
  port.checkOldVersionPropertyEdits.mockResolvedValue({
    transferred: [],
    conflicts: [],
    hintText: null,
  })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("the notices of the properties", () => {
  it("say nothing outside the desktop application and when all is well", async () => {
    port.propertyStorageStatus.mockResolvedValue(null)
    mount()
    await waitFor(() => expect(port.propertyStorageStatus).toHaveBeenCalled())
    expect(screen.queryByTestId("note-notices-bulb")).toBeNull()
  })

  it("offer the new format with a report first and run the migration only on the second click", async () => {
    port.propertyStorageStatus.mockResolvedValue({ mode: "legacy", oldVersionWarning: null })
    port.previewPropertiesMigration.mockResolvedValue({
      notes: 3,
      properties: 5,
      same: 4,
      mismatches: [],
      missingKeys: [],
      untouchable: [],
      orphans: [],
      headerEdits: 2,
      warnings: [],
    })
    port.runPropertiesMigration.mockResolvedValue({
      migrationId: "M",
      groupsWritten: 1,
      headersWritten: [],
      skippedChanged: [],
    })
    mount()
    await open()
    fireEvent.click(await screen.findByText("Показать отчёт"))
    expect(await screen.findByText(/Заметок: 3/)).toBeTruthy()
    expect(port.runPropertiesMigration).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText("Перенести свойства"))
    await waitFor(() => expect(port.runPropertiesMigration).toHaveBeenCalledTimes(1))
  })

  it("ask about a rename outside Amby and store a refusal", async () => {
    port.propertyStorageStatus.mockResolvedValue(groups)
    const hint = { oldName: "Статус", newName: "Состояние" }
    port.getPropertyPanel.mockResolvedValue(panel({ renameHint: hint }))
    port.dismissPropertyRenameHint.mockResolvedValue(undefined)
    mount()
    await open()
    expect(await screen.findByText(/«Статус» → «Состояние»/)).toBeTruthy()
    fireEvent.click(screen.getByText("Нет"))
    await waitFor(() => expect(port.dismissPropertyRenameHint).toHaveBeenCalledWith("N1", hint))
  })

  it("carry over the edits of an old version by themselves and tell how many notes", async () => {
    port.propertyStorageStatus.mockResolvedValue({
      mode: "groups",
      oldVersionWarning: "На устройствах со старой версией Amby не меняйте свойства",
    })
    port.checkOldVersionPropertyEdits.mockResolvedValue({
      transferred: ["N1", "N2"],
      conflicts: [],
      hintText:
        "Свойства, изменённые старой версией Amby на другом устройстве, перенесены: 2 заметки",
    })
    mount()
    await open()
    expect(await screen.findByText(/перенесены: 2 заметки/)).toBeTruthy()
    expect(screen.getByText(/со старой версией Amby не меняйте свойства/)).toBeTruthy()
  })

  it("let the owner choose after an edit made here and in an old version", async () => {
    port.propertyStorageStatus.mockResolvedValue({
      mode: "groups",
      oldVersionWarning: "Старая версия",
    })
    port.checkOldVersionPropertyEdits.mockResolvedValue({
      transferred: [],
      conflicts: ["N1", "N9"],
      hintText: null,
    })
    port.resolveOldVersionPropertyConflict.mockResolvedValue(undefined)
    mount()
    // an urgent card opens the stack by itself
    fireEvent.click(await screen.findByText("Оставить здешнее"))
    await waitFor(() =>
      expect(port.resolveOldVersionPropertyConflict).toHaveBeenCalledWith("N1", true),
    )
    // only the conflict of this note is a card of this note
    expect(port.resolveOldVersionPropertyConflict).toHaveBeenCalledTimes(1)
  })

  it("say in one line that the file of the properties is newer or has a line that cannot be read", async () => {
    port.propertyStorageStatus.mockResolvedValue(groups)
    port.getPropertyPanel.mockResolvedValue(
      panel({ warnings: [{ kind: "formatNewer" }, { kind: "badLineInGroup" }] }),
    )
    mount()
    await open()
    expect(await screen.findByText(/новее этой версии Amby/)).toBeTruthy()
    expect(screen.getByText(/нечитаемая строка/)).toBeTruthy()
  })
})
