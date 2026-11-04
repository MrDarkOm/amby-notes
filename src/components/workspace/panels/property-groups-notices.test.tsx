// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import "@/lib/i18n"
import type { PropertyPanel, PropertyStorageStatus } from "@/lib/properties/property-groups-port"

const port = vi.hoisted(() => ({
  propertyStorageStatus: vi.fn(),
  getPropertyPanel: vi.fn(),
  restoreDormantProperty: vi.fn(),
  purgeDormantProperty: vi.fn(),
  acceptPropertyRenameHint: vi.fn(),
  dismissPropertyRenameHint: vi.fn(),
  previewPropertiesMigration: vi.fn(),
  runPropertiesMigration: vi.fn(),
  checkOldVersionPropertyEdits: vi.fn(),
  resolveOldVersionPropertyConflict: vi.fn(),
}))

vi.mock("@/lib/properties/property-groups-port", () => port)

import { PropertyGroupsNotices } from "./property-groups-notices"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const groups: PropertyStorageStatus = { mode: "groups", oldVersionWarning: null }

const panel = (overrides: Partial<PropertyPanel> = {}): PropertyPanel => ({
  unreadable: false,
  active: [],
  dormant: [],
  renameHint: null,
  warnings: [],
  ...overrides,
})

describe("PropertyGroupsNotices", () => {
  it("shows nothing outside the desktop application", async () => {
    port.propertyStorageStatus.mockResolvedValue(null)
    const { container } = render(<PropertyGroupsNotices noteId="N1" />)
    await waitFor(() => expect(port.propertyStorageStatus).toHaveBeenCalled())
    expect(container.innerHTML).toBe("")
  })

  it("offers a dry-run report before the migration and runs it only after the second click", async () => {
    port.propertyStorageStatus.mockResolvedValue({ mode: "legacy", oldVersionWarning: null })
    port.previewPropertiesMigration.mockResolvedValue({
      notes: 3,
      properties: 5,
      same: 4,
      mismatches: [],
      missingKeys: [],
      untouchable: [],
      orphans: [],
      headerEdits: 0,
      warnings: ["Warn"],
    })
    port.runPropertiesMigration.mockResolvedValue({
      migrationId: "M",
      groupsWritten: 1,
      headersWritten: [],
      skippedChanged: [],
    })
    render(<PropertyGroupsNotices noteId="N1" />)
    fireEvent.click(await screen.findByText("Показать отчёт"))
    expect(await screen.findByText(/Заметок со свойствами: 3/)).toBeTruthy()
    expect(port.runPropertiesMigration).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText("Перенести свойства"))
    await waitFor(() => expect(port.runPropertiesMigration).toHaveBeenCalledTimes(1))
  })

  it("lists a record without a key and brings it back or deletes it on request", async () => {
    port.propertyStorageStatus.mockResolvedValue(groups)
    port.getPropertyPanel.mockResolvedValue(
      panel({
        dormant: [{ name: "Заказчик", icon: "📌", propertyType: "text", settings: "" }],
      }),
    )
    port.restoreDormantProperty.mockResolvedValue(undefined)
    render(<PropertyGroupsNotices noteId="N1" />)
    fireEvent.click(await screen.findByText("Вернуть"))
    await waitFor(() => expect(port.restoreDormantProperty).toHaveBeenCalledWith("N1", "Заказчик"))
    expect(screen.getByText("Удалить окончательно")).toBeTruthy()
  })

  it("asks about a rename outside Amby and stores a refusal", async () => {
    port.propertyStorageStatus.mockResolvedValue(groups)
    const hint = { oldName: "Статус", newName: "Состояние" }
    port.getPropertyPanel.mockResolvedValue(panel({ renameHint: hint }))
    port.dismissPropertyRenameHint.mockResolvedValue(undefined)
    render(<PropertyGroupsNotices noteId="N1" />)
    expect(await screen.findByText(/переименовали в «Состояние»/)).toBeTruthy()
    fireEvent.click(screen.getByText("Нет"))
    await waitFor(() => expect(port.dismissPropertyRenameHint).toHaveBeenCalledWith("N1", hint))
  })

  it("shows the sentence of the owner while an old version writes", async () => {
    port.propertyStorageStatus.mockResolvedValue({
      mode: "groups",
      oldVersionWarning: "На устройствах со старой версией Amby не меняйте свойства",
    })
    port.getPropertyPanel.mockResolvedValue(panel())
    render(<PropertyGroupsNotices noteId="N1" />)
    expect(await screen.findByText(/со старой версией Amby не меняйте свойства/)).toBeTruthy()
  })
})
