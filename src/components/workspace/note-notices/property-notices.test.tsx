// @vitest-environment happy-dom
// The warnings of the properties of a note are cards in the stack above the bottom bar, not blocks in
// the panel (docs/sync-plan.md, К3): the offer of the new format, the hint about a rename, what was
// carried over from an old version, the choice after an edit made in both places, the warning about
// an old version and the notes about the file of the properties.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
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

describe("the notices of the properties", () => {
  it("say nothing outside the desktop application and when all is well", async () => {
    port.propertyStorageStatus.mockResolvedValue(null)
    mount()
    await waitFor(() => expect(port.propertyStorageStatus).toHaveBeenCalled())
    expect(screen.queryByTestId("note-notices-bulb")).toBeNull()
  })

  it("tell once after the migration that the properties are in the new format, with no question before it", async () => {
    port.propertyStorageStatus.mockResolvedValue(groups)
    port.openVaultProperties.mockResolvedValue({
      state: "migrated",
      reason: null,
      migrationId: "M",
      diverged: [],
    })
    mount()
    await open()
    expect(await screen.findByText(/переведены в новый формат/)).toBeTruthy()
    expect(port.openVaultProperties).toHaveBeenCalledTimes(1)
  })

  it("list the notes whose values differed and take the value of the old file on request", async () => {
    port.propertyStorageStatus.mockResolvedValue(groups)
    port.openVaultProperties.mockResolvedValue({
      state: "migrated",
      reason: null,
      migrationId: "M",
      diverged: [{ noteId: "N7", name: "Заказчик", fileValue: "А", headerValue: "Б" }],
    })
    port.takePropertyFileValue.mockResolvedValue(undefined)
    mount()
    await screen.findByTestId("note-notices-stack")
    expect(await screen.findByText(/Расходились значения у 1 заметки/)).toBeTruthy()
    fireEvent.click(screen.getByText("Отчёт"))
    fireEvent.click(await screen.findByText("Взять значение из старого файла"))
    await waitFor(() =>
      expect(port.takePropertyFileValue).toHaveBeenCalledWith("N7", "Заказчик", "Заказчик"),
    )
  })

  it("say why the properties are read only when the vault could not be migrated", async () => {
    port.propertyStorageStatus.mockResolvedValue({ mode: "legacy", oldVersionWarning: null })
    port.openVaultProperties.mockResolvedValue({
      state: "readOnly",
      reason: "unreadableOldFile",
      migrationId: null,
      diverged: [],
    })
    mount()
    await screen.findByTestId("note-notices-stack")
    expect(await screen.findByText(/только для чтения/)).toBeTruthy()
  })

  it("open the stack by themselves for the important ones: differing values after the migration", async () => {
    port.propertyStorageStatus.mockResolvedValue(groups)
    port.openVaultProperties.mockResolvedValue({
      state: "migrated",
      reason: null,
      migrationId: "M",
      diverged: [{ noteId: "N7", name: "Заказчик", fileValue: "А", headerValue: "Б" }],
    })
    mount()
    expect(await screen.findByTestId("note-notices-stack")).toBeTruthy()
  })

  it("keep the plain «moved» notice under the bulb", async () => {
    port.propertyStorageStatus.mockResolvedValue(groups)
    port.openVaultProperties.mockResolvedValue({
      state: "migrated",
      reason: null,
      migrationId: "M",
      diverged: [],
    })
    mount()
    expect(await screen.findByTestId("note-notices-bulb")).toBeTruthy()
    expect(screen.queryByTestId("note-notices-stack")).toBeNull()
  })

  it("open the stack when the vault could not be migrated", async () => {
    port.propertyStorageStatus.mockResolvedValue({ mode: "legacy", oldVersionWarning: null })
    port.openVaultProperties.mockResolvedValue({
      state: "readOnly",
      reason: "waitingForSync",
      migrationId: null,
      diverged: [],
    })
    mount()
    expect(await screen.findByTestId("note-notices-stack")).toBeTruthy()
  })

  it("follow a rename: the value of the old file goes to the renamed key", async () => {
    port.propertyStorageStatus.mockResolvedValue(groups)
    port.openVaultProperties.mockResolvedValue({
      state: "migrated",
      reason: null,
      migrationId: "M",
      diverged: [{ noteId: "N7", name: "Статус", fileValue: "Идея", headerValue: "Готово" }],
    })
    port.takePropertyFileValue.mockResolvedValue(undefined)
    mount()
    await screen.findByTestId("note-notices-stack")
    act(() => usePropertyMigrationStore.getState().rename("N7", "Статус", "Статусы"))
    fireEvent.click(screen.getByText("Отчёт"))
    fireEvent.click(await screen.findByText("Взять значение из старого файла"))
    await waitFor(() =>
      expect(port.takePropertyFileValue).toHaveBeenCalledWith("N7", "Статус", "Статусы"),
    )
  })

  it("say in Russian that the property is gone, with the old value and no button, and write nothing", async () => {
    port.propertyStorageStatus.mockResolvedValue(groups)
    port.openVaultProperties.mockResolvedValue({
      state: "migrated",
      reason: null,
      migrationId: "M",
      diverged: [{ noteId: "N7", name: "Статус", fileValue: "Идея", headerValue: "Готово" }],
    })
    port.takePropertyFileValue.mockRejectedValue(new Error("No such property: Статус"))
    mount()
    await screen.findByTestId("note-notices-stack")
    fireEvent.click(screen.getByText("Отчёт"))
    fireEvent.click(await screen.findByText("Взять значение из старого файла"))
    expect(
      await screen.findByText(/Свойства «Статус» больше нет\. Значение из старого файла: «Идея»/),
    ).toBeTruthy()
    expect(screen.queryByText("Взять значение из старого файла")).toBeNull()
    expect(screen.queryByText(/No such property/)).toBeNull()
  })

  it("never show the raw English text of a backend error in a card", async () => {
    port.propertyStorageStatus.mockResolvedValue(groups)
    port.getPropertyPanel.mockResolvedValue(panel({ renameHint: { oldName: "А", newName: "Б" } }))
    port.acceptPropertyRenameHint.mockRejectedValue(new Error("YAML binding key is duplicated"))
    mount()
    await open()
    fireEvent.click(await screen.findByText("Перенести"))
    expect(await screen.findByText(/Не удалось выполнить действие/)).toBeTruthy()
    expect(screen.queryByText(/YAML binding/)).toBeNull()
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
