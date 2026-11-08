// @vitest-environment happy-dom
// The window of confirmation must work in the main window, in the separate window of settings and before
// any vault is open (the migrations ask in use-vault-data.ts): so the host stands in App, outside the workspace.
import * as React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"

vi.mock("./components/workspace/workspace", () => ({ Workspace: () => <p>workspace</p> }))
vi.mock("./components/workspace/settings-dialog", () => ({
  StandaloneSettingsWindow: () => <p>settings window</p>,
}))
vi.mock("./components/workspace/external-conflict-dialog", () => ({
  ExternalConflictDialog: () => null,
}))
vi.mock("./components/workspace/use-settings-store", () => ({
  useApplyPreferences: () => true,
  useWindowStatePersistence: () => true,
  useSettingsStore: (select: (state: unknown) => unknown) =>
    select({ prefs: { updates: { autoUpdate: false, channel: "stable" } } }),
}))
vi.mock("./lib/app-updater", () => ({ runAutomaticAppUpdate: vi.fn() }))
vi.mock("./components/theme-provider", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock("./components/ui/tooltip-provider", () => ({ TooltipProvider: () => null }))

async function mountApp(search: string) {
  window.history.replaceState(null, "", `/${search}`)
  vi.resetModules()
  const { default: App } = await import("./App")
  const { confirm } = await import("./lib/confirm")
  render(<App />)
  return confirm
}

beforeEach(() => {
  window.localStorage.clear()
})
afterEach(() => {
  cleanup()
  window.history.replaceState(null, "", "/")
})

describe("the host of the confirmation window in App", () => {
  it("answers in the main window", async () => {
    const confirm = await mountApp("")
    expect(await screen.findByText("workspace")).toBeTruthy()
    act(() => {
      void confirm({ title: "Удалить «План»?", confirmLabel: "Удалить", destructive: true })
    })
    expect(screen.getByRole("alertdialog", { name: "Удалить «План»?" })).toBeTruthy()
  })

  it("answers in the separate window of settings", async () => {
    const confirm = await mountApp("?ambyView=settings")
    expect(screen.getByText("settings window")).toBeTruthy()
    act(() => {
      void confirm({ title: "Сбросить настройки?", confirmLabel: "Сбросить", destructive: true })
    })
    expect(screen.getByRole("alertdialog", { name: "Сбросить настройки?" })).toBeTruthy()
  })
})
