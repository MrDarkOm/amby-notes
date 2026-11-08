// @vitest-environment happy-dom
// The questions of the settings (docs/notices.md, section 9): asked in the application, so they work in the separate
// window of settings too. "Cancel" changes nothing; "yes" does what it did.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import { confirm } from "@/lib/confirm"
import { BUILTIN_THEMES } from "@/lib/themes"
import { DEFAULT_PREFS } from "../app-config"
import { useSettingsStore } from "../use-settings-store"
import { DataTab } from "./settings-data"
import { ThemeLibrary } from "./settings-theme-library"

vi.mock("@/lib/confirm", () => ({ confirm: vi.fn() }))

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  vi.mocked(confirm).mockReset()
})
afterEach(cleanup)

describe("resetting the settings", () => {
  const setPrefs = vi.fn()
  beforeEach(() => {
    setPrefs.mockReset()
    useSettingsStore.setState({ setPrefs } as never)
  })
  const press = () => fireEvent.click(screen.getByRole("button", { name: "Сбросить настройки" }))

  it("is a dangerous question; Cancel resets nothing", async () => {
    vi.mocked(confirm).mockResolvedValue(false)
    render(<DataTab vault={null} />)
    press()
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(vi.mocked(confirm).mock.calls[0][0].destructive).toBe(true)
    expect(setPrefs).not.toHaveBeenCalled()
  })

  it("resets to the defaults after yes", async () => {
    vi.mocked(confirm).mockResolvedValue(true)
    render(<DataTab vault={null} />)
    press()
    await waitFor(() => expect(setPrefs).toHaveBeenCalledWith({ ...DEFAULT_PREFS }))
  })
})

describe("removing a theme from the library", () => {
  const theme = { ...BUILTIN_THEMES[0], id: "my-theme", name: "Закат" } as never
  const mount = () => {
    const onThemesChange = vi.fn()
    const onSelect = vi.fn()
    render(
      <ThemeLibrary
        selectedThemeId="my-theme"
        themes={[theme]}
        onSelect={onSelect}
        onThemesChange={onThemesChange}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.appearance.removeTheme") }))
    return { onThemesChange, onSelect }
  }

  it("names the theme, says the file stays, and removes nothing on Cancel", async () => {
    vi.mocked(confirm).mockResolvedValue(false)
    const { onThemesChange, onSelect } = mount()
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    const question = vi.mocked(confirm).mock.calls[0][0]
    expect(question.title).toContain("Закат")
    expect(question.description).toMatch(/файл/iu)
    expect(onThemesChange).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("removes the theme and goes back to the dark one after yes", async () => {
    vi.mocked(confirm).mockResolvedValue(true)
    const { onThemesChange, onSelect } = mount()
    await waitFor(() => expect(onThemesChange).toHaveBeenCalledWith([]))
    expect(onSelect).toHaveBeenCalledWith("dark")
  })
})
