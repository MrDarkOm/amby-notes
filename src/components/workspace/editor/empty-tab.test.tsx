// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import { EmptyTab } from "./empty-tab"

describe("EmptyTab", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
  })
  afterEach(cleanup)

  it("offers the next steps, each with its own action", () => {
    const actions = {
      onNewNote: vi.fn(),
      onNewDatabase: vi.fn(),
      onNewCanvas: vi.fn(),
      onQuickOpen: vi.fn(),
    }
    render(<EmptyTab hasVault {...actions} />)
    fireEvent.click(screen.getByRole("button", { name: /Новая заметка/ }))
    fireEvent.click(screen.getByRole("button", { name: /Создать базу данных/ }))
    fireEvent.click(screen.getByRole("button", { name: /Новый холст/ }))
    fireEvent.click(screen.getByRole("button", { name: /Перейти к файлу/ }))
    expect(actions.onNewNote).toHaveBeenCalledTimes(1)
    expect(actions.onNewDatabase).toHaveBeenCalledTimes(1)
    expect(actions.onNewCanvas).toHaveBeenCalledTimes(1)
    expect(actions.onQuickOpen).toHaveBeenCalledTimes(1)
  })

  it("shows the shortcut of the actions that have one", () => {
    render(<EmptyTab hasVault onNewNote={vi.fn()} onNewDatabase={vi.fn()} onQuickOpen={vi.fn()} />)
    expect(
      screen.getByRole("button", { name: /Новая заметка/ }).querySelector("kbd"),
    ).not.toBeNull()
    expect(
      screen.getByRole("button", { name: /Перейти к файлу/ }).querySelector("kbd"),
    ).not.toBeNull()
    expect(
      screen.getByRole("button", { name: /Создать базу данных/ }).querySelector("kbd"),
    ).toBeNull()
  })

  it("leaves out what is not available, such as a module that is off", () => {
    render(<EmptyTab hasVault onNewNote={vi.fn()} onQuickOpen={vi.fn()} />)
    expect(screen.queryByRole("button", { name: /Создать базу данных/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /Новый холст/ })).toBeNull()
    expect(screen.getAllByRole("button")).toHaveLength(2)
  })

  it("offers only opening a vault when none is open", () => {
    const onOpenVault = vi.fn()
    render(<EmptyTab hasVault={false} onNewNote={vi.fn()} onOpenVault={onOpenVault} />)
    expect(screen.queryByRole("button", { name: /Новая заметка/ })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /Открыть хранилище/ }))
    expect(onOpenVault).toHaveBeenCalledTimes(1)
  })

  it("offers an Excalidraw drawing beside the canvas", () => {
    const onNewSketch = vi.fn()
    render(<EmptyTab hasVault onNewNote={vi.fn()} onNewSketch={onNewSketch} />)
    fireEvent.click(screen.getByRole("button", { name: /Создать Excalidraw/ }))
    expect(onNewSketch).toHaveBeenCalledTimes(1)
  })

  it("puts the creative actions under their own heading, only when they are given", () => {
    const creative = {
      onNewStory: vi.fn(),
      onNewUniverse: vi.fn(),
      onOpenWorkshop: vi.fn(),
    }
    const view = render(<EmptyTab hasVault onNewNote={vi.fn()} creative={creative} />)
    expect(screen.getByText("Творчество")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /Создать историю/ }))
    fireEvent.click(screen.getByRole("button", { name: /Создать вселенную/ }))
    fireEvent.click(screen.getByRole("button", { name: /Открыть Мастерскую/ }))
    expect(creative.onNewStory).toHaveBeenCalledTimes(1)
    expect(creative.onNewUniverse).toHaveBeenCalledTimes(1)
    expect(creative.onOpenWorkshop).toHaveBeenCalledTimes(1)
    view.unmount()

    render(<EmptyTab hasVault onNewNote={vi.fn()} />)
    expect(screen.queryByText("Творчество")).toBeNull()
    expect(screen.queryByRole("button", { name: /Создать историю/ })).toBeNull()
  })

  it("offers no creative actions without a vault", () => {
    render(
      <EmptyTab
        hasVault={false}
        onOpenVault={vi.fn()}
        creative={{ onNewStory: vi.fn(), onNewUniverse: vi.fn(), onOpenWorkshop: vi.fn() }}
      />,
    )
    expect(screen.queryByText("Творчество")).toBeNull()
  })
})
