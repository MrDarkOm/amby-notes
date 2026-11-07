// @vitest-environment happy-dom
// The cards about the properties of a note have a level of docs/notices.md (section 2.1) and are drawn
// by it (step 1 of the transition). When and how they open stays as it was.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import i18n from "@/lib/i18n"
import type { PropertyPanel, PropertyStorageStatus } from "@/lib/properties/property-groups-port"
import { useVaultStore } from "../use-vault-store"
import { usePropertyMigrationStore } from "./use-property-migration-store"

const port = vi.hoisted(() => ({
  propertyStorageStatus: vi.fn(),
  getPropertyPanel: vi.fn(),
  acceptPropertyRenameHint: vi.fn(),
  dismissPropertyRenameHint: vi.fn(),
  openVaultProperties: vi.fn(),
  takePropertyFileValue: vi.fn(),
  checkOldVersionPropertyEdits: vi.fn(),
  resolveOldVersionPropertyConflict: vi.fn(),
}))
vi.mock("@/lib/properties/property-groups-port", () => port)
const storage = vi.hoisted(() => ({ getNoteProperties: vi.fn() }))
vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  getNoteProperties: storage.getNoteProperties,
}))

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
const migrated = (diverged: unknown[] = []) => ({
  state: "migrated",
  reason: null,
  migrationId: "M",
  diverged,
})
const item = { noteId: "N7", name: "Заказчик", fileValue: "А", headerValue: "Б" }

function mount() {
  return render(
    <NoteNotices document={{ id: "N1", path: "/vault/Заметка.md" }} warningKey={null} />,
  )
}

async function card(testId: string) {
  const bulb = await screen.findByTestId("note-notices-bulb")
  if (!screen.queryByTestId("note-notices-stack")) fireEvent.click(bulb)
  return screen.findByTestId(testId)
}

beforeEach(async () => {
  port.openVaultProperties.mockResolvedValue({
    state: "alreadyGroups",
    reason: null,
    migrationId: null,
    diverged: [],
  })
  usePropertyMigrationStore.setState(usePropertyMigrationStore.getInitialState())
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

describe("the level of the cards of the properties", () => {
  it("properties that are read only are a warning", async () => {
    port.propertyStorageStatus.mockResolvedValue({ mode: "legacy", oldVersionWarning: null })
    port.openVaultProperties.mockResolvedValue({
      state: "readOnly",
      reason: "unreadableOldFile",
      migrationId: null,
      diverged: [],
    })
    mount()
    expect((await card("note-notice-properties-read-only")).getAttribute("data-level")).toBe(
      "warning",
    )
  })

  it("«moved to the new format» is information when all values agree", async () => {
    port.propertyStorageStatus.mockResolvedValue(groups)
    port.openVaultProperties.mockResolvedValue(migrated())
    mount()
    expect((await card("note-notice-properties-migrated")).getAttribute("data-level")).toBe("info")
  })

  it("«moved» with differing values is a warning, and so is each differing value", async () => {
    port.propertyStorageStatus.mockResolvedValue(groups)
    port.openVaultProperties.mockResolvedValue(migrated([item]))
    mount()
    expect((await card("note-notice-properties-migrated")).getAttribute("data-level")).toBe(
      "warning",
    )
    fireEvent.click(screen.getByText("Отчёт"))
    expect(
      (await screen.findByTestId("note-notice-properties-diverged")).getAttribute("data-level"),
    ).toBe("warning")
  })

  it("a file of properties that is newer, and a line that cannot be read, are warnings", async () => {
    port.propertyStorageStatus.mockResolvedValue(groups)
    port.getPropertyPanel.mockResolvedValue(
      panel({ warnings: [{ kind: "formatNewer" }, { kind: "badLineInGroup" }] }),
    )
    mount()
    expect((await card("note-notice-properties-newer")).getAttribute("data-level")).toBe("warning")
    expect(screen.getByTestId("note-notice-properties-bad-line").getAttribute("data-level")).toBe(
      "warning",
    )
  })

  it("a hint about a rename outside Amby is information", async () => {
    port.propertyStorageStatus.mockResolvedValue(groups)
    port.getPropertyPanel.mockResolvedValue(
      panel({ renameHint: { oldName: "Статус", newName: "Состояние" } }),
    )
    mount()
    expect((await card("note-notice-properties-rename")).getAttribute("data-level")).toBe("info")
  })

  it("an edit made here and in an old version is a decision", async () => {
    port.propertyStorageStatus.mockResolvedValue({ mode: "groups", oldVersionWarning: "Старая" })
    port.checkOldVersionPropertyEdits.mockResolvedValue({
      transferred: [],
      conflicts: ["N1"],
      hintText: null,
    })
    mount()
    expect((await card("note-notice-properties-old-conflict")).getAttribute("data-level")).toBe(
      "decision",
    )
  })

  it("what was carried over from an old version, and the old version itself, are information", async () => {
    port.propertyStorageStatus.mockResolvedValue({
      mode: "groups",
      oldVersionWarning: "Не меняйте свойства",
    })
    port.checkOldVersionPropertyEdits.mockResolvedValue({
      transferred: ["N1"],
      conflicts: [],
      hintText: "Перенесены свойства: 1 заметка",
    })
    mount()
    expect((await card("note-notice-properties-transferred")).getAttribute("data-level")).toBe(
      "info",
    )
    expect(
      screen.getByTestId("note-notice-properties-old-version").getAttribute("data-level"),
    ).toBe("info")
  })

  it("no card of the properties keeps an amber class", async () => {
    port.propertyStorageStatus.mockResolvedValue(groups)
    port.openVaultProperties.mockResolvedValue(migrated([item]))
    port.getPropertyPanel.mockResolvedValue(
      panel({ warnings: [{ kind: "formatNewer" }], renameHint: { oldName: "А", newName: "Б" } }),
    )
    mount()
    await card("note-notice-properties-migrated")
    expect(screen.getByTestId("note-notices-stack").innerHTML).not.toMatch(/amber/)
  })
})
