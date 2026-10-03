// @vitest-environment happy-dom
import { chooseOption } from "@/lib/test-utils/amby-select"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import type { DatabaseSummary, DatabaseViewSummary } from "@/lib/storage"
import { ViewSettingsPanel, type ViewSettingsPanelProps } from "./view-settings-panel"

const view = (layout: string): DatabaseViewSummary => ({
  viewId: "v1",
  title: "Мой вид",
  layout,
  revision: "r",
  groupField: null,
})

const database = {
  databaseId: "d",
  title: "Tasks",
  views: [view("table"), view("board")],
  templates: [],
  properties: [
    { propertyId: "s", name: "Status", propertyType: "status", configJson: "{}", options: [] },
    { propertyId: "h", name: "Hours", propertyType: "number", configJson: "{}", options: [] },
  ],
} as unknown as DatabaseSummary

function props(overrides: Partial<ViewSettingsPanelProps> = {}): ViewSettingsPanelProps {
  return {
    isCompactToolbar: false,
    isDatabaseLocked: false,
    vaultGeneration: 1,
    activeView: view("table"),
    database,
    mutationBusy: false,
    searchOpen: false,
    isLinkCopied: false,
    activeHiddenPropertyIds: new Set(),
    cardSize: "medium",
    openMode: "sidePeek",
    onOpenModeChange: vi.fn(),
    onCardSizeChange: vi.fn(),
    groupPropertyId: null,
    onGroupPropertyChange: vi.fn(),
    coverVisible: true,
    onCoverVisibleChange: vi.fn(),
    filterCount: 0,
    sortCount: 0,
    onOpenFilter: vi.fn(),
    onOpenSort: vi.fn(),
    openRowDialog: vi.fn(),
    onToggleSearch: vi.fn(),
    onViewIconChange: vi.fn(),
    onRenameView: vi.fn(),
    renderPropertySettings: () => null,
    propertyIconOf: () => undefined,
    onPropertyIconChange: vi.fn(),
    onRenameProperty: vi.fn(),
    onChangePropertyType: vi.fn(),
    onDeleteProperty: vi.fn(),
    changeActiveViewLayout: vi.fn(),
    setViewHiddenPropertyIds: vi.fn(),
    togglePropertyVisibility: vi.fn(),
    onOpenAddProperty: vi.fn(),
    copyLinkToView: vi.fn(),
    handleToggleLock: vi.fn(),
    mutateView: vi.fn(),
    top: 48,
    onClose: vi.fn(),
    ...overrides,
  }
}

describe("ViewSettingsPanel", () => {
  afterEach(cleanup)

  it("shows only the settings the layout needs", () => {
    const { rerender } = render(<ViewSettingsPanel {...props()} />)
    expect(screen.queryByText("Колонки по свойству")).toBeNull()
    rerender(<ViewSettingsPanel {...props({ activeView: view("board") })} />)
    expect(screen.getByText("Колонки по свойству")).toBeTruthy()
    expect(screen.queryByText("Обложка на карточках")).toBeNull()
    rerender(<ViewSettingsPanel {...props({ activeView: view("gallery") })} />)
    expect(screen.getByText("Обложка на карточках")).toBeTruthy()
    expect(screen.getByText("Размер карточек")).toBeTruthy()
  })

  it("stays open and keeps its page when the layout changes", async () => {
    const change = vi.fn()
    const onClose = vi.fn()
    const { rerender } = render(
      <ViewSettingsPanel {...props({ changeActiveViewLayout: change, onClose })} />,
    )
    fireEvent.click(screen.getByRole("button", { name: /Раскладка/ }))
    fireEvent.click(await screen.findByRole("radio", { name: "Доска" }))
    expect(change).toHaveBeenCalledWith("board")
    // The parent re-renders with the new layout: the panel and its page are still there.
    rerender(
      <ViewSettingsPanel
        {...props({ activeView: view("board"), changeActiveViewLayout: change, onClose })}
      />,
    )
    expect(screen.getByRole("radio", { name: "Доска" }).getAttribute("aria-checked")).toBe("true")
    expect(onClose).not.toHaveBeenCalled()
  })

  it("goes back from a page with the Back button and with Escape, and closes from the list", async () => {
    const onClose = vi.fn()
    render(<ViewSettingsPanel {...props({ onClose })} />)
    fireEvent.click(screen.getByRole("button", { name: /Видимые свойства/ }))
    expect(await screen.findByLabelText("Hours")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Назад" }))
    expect(await screen.findByRole("button", { name: /Раскладка/ })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /Открывать запись/ }))
    const radio = await screen.findByRole("radio", { name: /Сбоку/ })
    fireEvent.keyDown(radio, { key: "Escape" })
    expect(onClose).not.toHaveBeenCalled()
    expect(await screen.findByRole("button", { name: /Раскладка/ })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole("complementary"), { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("toggles property visibility with switches; cards have no separate property list", async () => {
    const toggle = vi.fn()
    render(
      <ViewSettingsPanel
        {...props({ activeView: view("gallery"), togglePropertyVisibility: toggle })}
      />,
    )
    expect(screen.queryByText("Поля карточек")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /Видимые свойства/ }))
    fireEvent.click(await screen.findByRole("switch", { name: "Hours" }))
    expect(toggle).toHaveBeenCalledWith("h")
  })

  it("renames the view in place from its name field", async () => {
    const rename = vi.fn(async () => {})
    render(<ViewSettingsPanel {...props({ onRenameView: rename })} />)
    const input = screen.getByLabelText("Название представления") as HTMLInputElement
    expect(input.value).toBe("Мой вид")
    fireEvent.change(input, { target: { value: "  Новый вид " } })
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.blur(input)
    await vi.waitFor(() => expect(rename).toHaveBeenCalledWith("Новый вид"))
  })

  it("changes the view icon from the icon beside the name", () => {
    render(<ViewSettingsPanel {...props({ viewIcon: "🚀" })} />)
    expect(screen.getByRole("button", { name: "Сменить иконку вида" }).textContent).toBe("🚀")
  })

  it("chooses the board columns and the way a record opens", async () => {
    const group = vi.fn()
    const openMode = vi.fn()
    render(
      <ViewSettingsPanel
        {...props({
          activeView: view("board"),
          onGroupPropertyChange: group,
          onOpenModeChange: openMode,
        })}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /Колонки по свойству/ }))
    fireEvent.click(await screen.findByRole("radio", { name: "Status" }))
    expect(group).toHaveBeenCalledWith("s")
    fireEvent.click(screen.getByRole("button", { name: "Назад" }))
    fireEvent.click(await screen.findByRole("button", { name: /Открывать запись/ }))
    fireEvent.click(await screen.findByRole("radio", { name: /В центре/ }))
    expect(openMode).toHaveBeenCalledWith("centerPeek")
  })

  it("switches the gallery cover and size without leaving the list", () => {
    const cover = vi.fn()
    const size = vi.fn()
    render(
      <ViewSettingsPanel
        {...props({
          activeView: view("gallery"),
          onCoverVisibleChange: cover,
          onCardSizeChange: size,
        })}
      />,
    )
    fireEvent.click(screen.getByRole("switch", { name: "Обложка на карточках" }))
    expect(cover).toHaveBeenCalledWith(false)
    fireEvent.click(screen.getByRole("radio", { name: "Крупные" }))
    expect(size).toHaveBeenCalledWith("large")
  })

  it("disables edits of a locked database but keeps the lock control", () => {
    const toggleLock = vi.fn()
    render(
      <ViewSettingsPanel {...props({ isDatabaseLocked: true, handleToggleLock: toggleLock })} />,
    )
    expect(screen.getByRole("button", { name: /Дублировать/ }).hasAttribute("disabled")).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: /Разблокировать/ }))
    expect(toggleLock).toHaveBeenCalled()
  })

  it("offers the toolbar actions in a compact workspace only", () => {
    const { rerender } = render(<ViewSettingsPanel {...props()} />)
    expect(screen.queryByRole("button", { name: "Закрыть поиск" })).toBeNull()
    expect(screen.queryByRole("button", { name: /Поиск/ })).toBeNull()
    rerender(<ViewSettingsPanel {...props({ isCompactToolbar: true })} />)
    expect(screen.getByRole("button", { name: /Поиск/ })).toBeTruthy()
  })

  it("returns to the list when its page no longer applies to the layout", async () => {
    const { rerender } = render(<ViewSettingsPanel {...props({ activeView: view("board") })} />)
    fireEvent.click(screen.getByRole("button", { name: /Колонки по свойству/ }))
    expect(await screen.findByRole("radio", { name: "Status" })).toBeTruthy()
    rerender(<ViewSettingsPanel {...props({ activeView: view("table") })} />)
    expect(await screen.findByRole("button", { name: /Раскладка/ })).toBeTruthy()
  })

  describe("editing properties", () => {
    const open = async (overrides: Partial<ViewSettingsPanelProps> = {}) => {
      render(<ViewSettingsPanel {...props(overrides)} />)
      fireEvent.click(screen.getByRole("button", { name: /Редактировать свойства/ }))
      await screen.findByText(/Выберите свойство/)
    }

    it("lists the properties and opens the one picked, with a way back", async () => {
      await open()
      expect(screen.getByRole("button", { name: /Status/ })).toBeTruthy()
      expect(screen.getByRole("button", { name: /Hours/ })).toBeTruthy()
      fireEvent.click(screen.getByRole("button", { name: /Hours/ }))
      expect(await screen.findByLabelText("Название свойства")).toBeTruthy()
      // Back leads to the list of properties, then to the settings list.
      fireEvent.click(screen.getByRole("button", { name: "Назад" }))
      expect(await screen.findByText(/Выберите свойство/)).toBeTruthy()
      fireEvent.click(screen.getByRole("button", { name: "Назад" }))
      expect(await screen.findByRole("button", { name: /Раскладка/ })).toBeTruthy()
    })

    it("shows the property's own settings in its menu", async () => {
      await open({
        renderPropertySettings: (property) => (
          <div data-testid="settings">settings of {property.name}</div>
        ),
      })
      fireEvent.click(screen.getByRole("button", { name: /Status/ }))
      expect((await screen.findByTestId("settings")).textContent).toBe("settings of Status")
    })

    it("renames, changes the type, hides in the view and deletes", async () => {
      const rename = vi.fn(async () => {})
      const changeType = vi.fn()
      const toggle = vi.fn()
      const remove = vi.fn()
      await open({
        onRenameProperty: rename,
        onChangePropertyType: changeType,
        togglePropertyVisibility: toggle,
        onDeleteProperty: remove,
      })
      fireEvent.click(screen.getByRole("button", { name: /Hours/ }))
      const name = (await screen.findByLabelText("Название свойства")) as HTMLInputElement
      fireEvent.change(name, { target: { value: "Time" } })
      fireEvent.blur(name)
      await vi.waitFor(() => expect(rename).toHaveBeenCalledWith("h", "Time"))
      await chooseOption("Тип свойства", "Текст")
      expect(changeType).toHaveBeenCalledWith("h", "text")
      fireEvent.click(screen.getByRole("switch", { name: "Показывать в этом виде" }))
      expect(toggle).toHaveBeenCalledWith("h")
      fireEvent.click(screen.getByRole("button", { name: "Удалить свойство" }))
      expect(remove).toHaveBeenCalledWith("h")
    })

    it("leaves the page of a property that no longer exists", async () => {
      const { rerender } = render(<ViewSettingsPanel {...props()} />)
      fireEvent.click(screen.getByRole("button", { name: /Редактировать свойства/ }))
      fireEvent.click(await screen.findByRole("button", { name: /Hours/ }))
      await screen.findByLabelText("Название свойства")
      const without = {
        ...database,
        properties: database.properties.filter((p) => p.propertyId !== "h"),
      } as unknown as DatabaseSummary
      rerender(<ViewSettingsPanel {...props({ database: without })} />)
      expect(await screen.findByText(/Выберите свойство/)).toBeTruthy()
    })

    it("does not let a locked database be edited", async () => {
      await open({ isDatabaseLocked: true })
      fireEvent.click(screen.getByRole("button", { name: /Hours/ }))
      expect(
        (await screen.findByRole("button", { name: "Удалить свойство" })).hasAttribute("disabled"),
      ).toBe(true)
    })
  })

  it("puts the cursor in the view's name when asked, from any page", async () => {
    const { rerender } = render(<ViewSettingsPanel {...props()} />)
    fireEvent.click(screen.getByRole("button", { name: /Открывать запись/ }))
    await screen.findByRole("radio", { name: /Сбоку/ })
    rerender(<ViewSettingsPanel {...props({ focusNameSignal: 1 })} />)
    const name = (await screen.findByLabelText("Название представления")) as HTMLInputElement
    await vi.waitFor(() => expect(document.activeElement).toBe(name))
    // Something takes the focus away (a closing menu returns it to its trigger): it is taken again.
    ;(document.activeElement as HTMLElement).blur()
    rerender(<ViewSettingsPanel {...props({ focusNameSignal: 2 })} />)
    await vi.waitFor(() => expect(document.activeElement).toBe(name))
  })
})
