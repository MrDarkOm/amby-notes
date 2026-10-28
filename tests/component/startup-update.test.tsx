// @vitest-environment happy-dom
import * as React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import type { StartupUpdateResult } from "@/lib/app-updater"

const startup = vi.hoisted(() => ({
  preferencesReady: true,
  windowStateReady: true,
  autoUpdate: true,
  channel: "stable" as "stable" | "beta",
  run: vi.fn(),
}))

vi.mock("@/lib/app-updater", () => ({ runAutomaticAppUpdate: startup.run }))
vi.mock("@/components/workspace/use-settings-store", () => ({
  useApplyPreferences: () => startup.preferencesReady,
  useWindowStatePersistence: () => startup.windowStateReady,
  useSettingsStore: (select: (state: unknown) => unknown) =>
    select({ prefs: { updates: { autoUpdate: startup.autoUpdate, channel: startup.channel } } }),
}))
vi.mock("@/components/theme-provider", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock("motion/react", () => ({
  MotionConfig: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock("@/lib/motion", () => ({ MotionPulse: () => <div /> }))
vi.mock("@/components/ui/tooltip-provider", () => ({ TooltipProvider: () => null }))
vi.mock("@/components/workspace/workspace", () => ({
  Workspace: () => <div data-testid="workspace" />,
}))
vi.mock("@/components/workspace/external-conflict-dialog", () => ({
  ExternalConflictDialog: () => <div data-testid="conflict-dialog" />,
}))
vi.mock("@/components/workspace/settings-dialog", () => ({
  StandaloneSettingsWindow: () => <div data-testid="settings" />,
}))

let settleStartup: (result: StartupUpdateResult) => void

beforeEach(() => {
  vi.resetModules()
  startup.run.mockReset()
  startup.preferencesReady = true
  startup.windowStateReady = true
  startup.autoUpdate = true
  startup.channel = "stable"
  startup.run.mockReturnValue(
    new Promise<StartupUpdateResult>((resolve) => (settleStartup = resolve)),
  )
  window.history.replaceState(null, "", "/")
})

afterEach(cleanup)

describe("workspace startup update gate", () => {
  it("waits for hydrated preferences, then checks before mounting the workspace", async () => {
    startup.preferencesReady = false
    const { default: App } = await import("@/App")
    const view = render(<App />)
    expect(startup.run).not.toHaveBeenCalled()
    expect(screen.queryByTestId("workspace")).toBeNull()

    startup.preferencesReady = true
    view.rerender(<App />)
    expect(startup.run).toHaveBeenCalledOnce()
    expect(startup.run).toHaveBeenCalledWith("stable")
    expect(screen.queryByTestId("workspace")).toBeNull()
    expect(screen.queryByTestId("conflict-dialog")).toBeNull()
    await act(async () => settleStartup("ready"))
    expect(screen.getByTestId("workspace")).toBeTruthy()
  })

  it("keeps the old workspace closed after installation while restarting", async () => {
    const { default: App } = await import("@/App")
    render(<App />)
    await act(async () => settleStartup("restarting"))
    expect(screen.queryByTestId("workspace")).toBeNull()
    expect(screen.queryByTestId("conflict-dialog")).toBeNull()
    expect(screen.getByRole("main").getAttribute("aria-busy")).toBe("true")
  })

  it("uses the hydrated beta channel for its single startup check", async () => {
    startup.channel = "beta"
    const { default: App } = await import("@/App")
    render(<App />)
    expect(startup.run).toHaveBeenCalledOnce()
    expect(startup.run).toHaveBeenCalledWith("beta")
    await act(async () => settleStartup("ready"))
  })

  it("awaits the same task across StrictMode effect subscriptions", async () => {
    const { default: App } = await import("@/App")
    render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    )
    expect(startup.run).toHaveBeenCalledOnce()
    expect(screen.queryByTestId("workspace")).toBeNull()
    await act(async () => settleStartup("ready"))
    expect(screen.getByTestId("workspace")).toBeTruthy()
  })

  it("bypasses a disabled startup update and applies enabling on the next launch", async () => {
    startup.autoUpdate = false
    const { default: App } = await import("@/App")
    const view = render(<App />)
    await act(async () => {})
    expect(screen.getByTestId("workspace")).toBeTruthy()
    startup.autoUpdate = true
    view.rerender(<App />)
    expect(startup.run).not.toHaveBeenCalled()
    expect(screen.getByTestId("workspace")).toBeTruthy()
  })

  it("does not open mid-install when the stored preference changes", async () => {
    const { default: App } = await import("@/App")
    const view = render(<App />)
    startup.autoUpdate = false
    startup.channel = "beta"
    view.rerender(<App />)
    expect(startup.run).toHaveBeenCalledOnce()
    expect(startup.run).toHaveBeenCalledWith("stable")
    expect(screen.queryByTestId("workspace")).toBeNull()
    await act(async () => settleStartup("ready"))
    expect(screen.getByTestId("workspace")).toBeTruthy()
  })

  it("keeps window-state restoration as a separate startup gate", async () => {
    startup.windowStateReady = false
    const { default: App } = await import("@/App")
    const view = render(<App />)
    await act(async () => settleStartup("ready"))
    expect(screen.queryByTestId("workspace")).toBeNull()
    startup.windowStateReady = true
    view.rerender(<App />)
    expect(screen.getByTestId("workspace")).toBeTruthy()
  })

  it("opens standalone settings without starting an automatic update", async () => {
    window.history.replaceState(null, "", "/?ambyView=settings")
    const { default: App } = await import("@/App")
    render(<App />)
    expect(screen.getByTestId("settings")).toBeTruthy()
    expect(startup.run).not.toHaveBeenCalled()
    expect(screen.queryByTestId("workspace")).toBeNull()
  })

  it("suppresses the default system context menu across the window", async () => {
    startup.autoUpdate = false
    const { default: App } = await import("@/App")
    render(<App />)
    await act(async () => {})
    const workspace = screen.getByTestId("workspace")
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
    workspace.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })
})
