// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import type { DatabaseSummary } from "@/lib/storage"
import type { PanelRenderProps } from "../panel-registry"
import { useDatabaseStore } from "../database/database-store"
import { DatabasesPanel } from "./databases-panel"

const database: DatabaseSummary = {
  databaseId: "db",
  title: "Локации",
  attachedNoteId: "atlas",
  icon: null,
  manifestRevision: "r1",
  locked: false,
  properties: [],
  templates: [],
  diagnostics: [],
  views: [
    { viewId: "table", title: "Все локации", layout: "table", revision: "r1", groupField: null },
    { viewId: "gallery", title: "Атлас", layout: "gallery", revision: "r1", groupField: null },
  ],
}

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  useDatabaseStore.getState().reset(1)
})
afterEach(() => {
  cleanup()
  useDatabaseStore.getState().reset(null)
})

function mount(overrides: Partial<PanelRenderProps> = {}) {
  const onOpenDatabase = vi.fn()
  const onSelect = vi.fn()
  render(
    <DatabasesPanel
      treeItems={[
        {
          id: "folder",
          name: "Мир",
          path: "/vault/Мир",
          type: "folder",
          children: [
            { id: "atlas", name: "Атлас.md", path: "/vault/Мир/Атлас/Атлас.md", type: "file" },
          ],
        },
      ]}
      selectedId={null}
      vault="/vault"
      onSelect={onSelect}
      onOpenVault={vi.fn()}
      databaseRuntimeEnabled
      onOpenDatabase={onOpenDatabase}
      {...overrides}
    />,
  )
  return { onOpenDatabase, onSelect }
}

function openMenu(name: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name }), { button: 0, ctrlKey: false })
}

describe("database panel navigation", () => {
  it.each(["DuplicateDatabaseTitle", "duplicateDatabaseTitle"])(
    "does not warn about %s in catalog or database rows",
    (code) => {
      useDatabaseStore.getState().setCatalog([
        {
          ...database,
          diagnostics: [
            {
              code,
              severity: "Warning",
              path: "Локации/Локации.json",
              message: "database title is also declared by other.json",
            },
          ],
        },
      ])
      useDatabaseStore.setState({
        diagnostics: [
          { code, severity: "Warning", path: "other.json", message: "duplicate title" },
        ],
      })
      mount()
      expect(screen.queryByRole("button", { name: /duplicate|Есть другая база/ })).toBeNull()
    },
  )

  it("keeps real warnings and pins a hovered hint on click", async () => {
    useDatabaseStore.getState().setCatalog([
      {
        ...database,
        diagnostics: [
          {
            code: "DuplicateDatabaseTitle",
            severity: "Warning",
            path: "a.json",
            message: "duplicate title",
          },
          {
            code: "DuplicateDatabaseId",
            severity: "Error",
            path: "a.json",
            message: "Duplicate ID",
          },
        ],
      },
    ])
    // The person reads the dictionary text for the code, never the sentence the backend sent.
    const text = i18n.t("databaseErrors.diagnostic.duplicateDatabaseId")
    const { onOpenDatabase } = mount()
    const trigger = screen.getByRole("button", { name: text })
    fireEvent.pointerEnter(trigger)
    expect(await screen.findByText(text)).toBeTruthy()
    fireEvent.pointerDown(trigger, { button: 0 })
    fireEvent.click(trigger)
    fireEvent.pointerLeave(trigger)
    await new Promise((resolve) => setTimeout(resolve, 180))
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByText(text)).toBeTruthy()
    expect(screen.queryByText("duplicate title")).toBeNull()
    expect(onOpenDatabase).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByText(text), { key: "Escape" })
    await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"))
  })

  it("shows the owning note and searches its path", () => {
    useDatabaseStore.getState().setCatalog([database])
    mount()
    expect(screen.getByText("Мир / Атлас")).toBeTruthy()
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Атлас" } })
    expect(screen.getByText("Локации")).toBeTruthy()
  })

  it("opens a specific saved view from the arrow without opening the default view first", () => {
    useDatabaseStore.getState().setCatalog([database])
    const { onOpenDatabase } = mount()
    openMenu("Выбрать представление")
    expect(onOpenDatabase).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("menuitem", { name: "Атлас" }))
    expect(useDatabaseStore.getState().requestedView).toEqual({
      databaseId: "db",
      viewId: "gallery",
    })
    expect(onOpenDatabase).toHaveBeenCalledExactlyOnceWith("db", "Локации")
  })

  it("opens a new tab from the ellipsis menu", () => {
    useDatabaseStore.getState().setCatalog([database])
    const { onOpenDatabase } = mount()
    openMenu("Действия с базой")
    fireEvent.click(screen.getByRole("menuitem", { name: "Открыть в новой вкладке" }))
    expect(onOpenDatabase).toHaveBeenCalledExactlyOnceWith("db", "Локации", true)
  })

  it("opens the owning note from the ellipsis menu", () => {
    useDatabaseStore.getState().setCatalog([database])
    const { onSelect } = mount()
    openMenu("Действия с базой")
    fireEvent.click(screen.getByRole("menuitem", { name: "Открыть связанную заметку" }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("atlas")
  })
})
