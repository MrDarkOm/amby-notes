// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from "vitest"
import { render, screen, act, cleanup } from "@testing-library/react"
import "@/lib/i18n"
import { SettingsDialog } from "@/components/workspace/settings-dialog"
import { useSettingsStore } from "@/components/workspace/use-settings-store"
import { DEFAULT_PREFS } from "@/components/workspace/app-config"

describe("SettingsDialog component", () => {
  beforeEach(() => {
    cleanup()
    localStorage.clear()
  })

  it("does not render contents when open is false", () => {
    const { container } = render(
      <SettingsDialog
        open={false}
        onOpenChange={() => {}}
        activeModules={["files", "tags"]}
        onModuleEnabledChange={() => {}}
        dockPrefs={DEFAULT_PREFS.docks}
        onDockPrefsChange={() => {}}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders tabs and displays current preferences", async () => {
    render(
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        activeModules={["files", "tags"]}
        onModuleEnabledChange={() => {}}
        dockPrefs={DEFAULT_PREFS.docks}
        onDockPrefsChange={() => {}}
      />,
    )

    const generalTab = screen.getByRole("tab", { name: /Общие/i })
    const appearanceTab = screen.getByRole("tab", { name: /Оформление/i })
    const modulesTab = screen.getByRole("tab", { name: /Модули/i })

    expect(generalTab).toBeTruthy()
    expect(appearanceTab).toBeTruthy()
    expect(modulesTab).toBeTruthy()
    expect(generalTab.getAttribute("data-state")).toBe("active")
  })

  it("updates theme preference in useSettingsStore", async () => {
    act(() => {
      useSettingsStore.getState().setPrefs({ theme: "dark" })
    })

    expect(useSettingsStore.getState().prefs.theme).toBe("dark")

    act(() => {
      useSettingsStore.getState().setPrefs({ theme: "light" })
    })

    expect(useSettingsStore.getState().prefs.theme).toBe("light")
  })
})
