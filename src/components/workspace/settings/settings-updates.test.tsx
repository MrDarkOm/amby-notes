// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { chooseOption, selectedText } from "@/lib/test-utils/amby-select"
import { UpdateSettings } from "./settings-updates"

const settings = vi.hoisted(() => ({
  updates: { autoUpdate: true, channel: "stable" as "stable" | "beta" },
  setPrefs: vi.fn(),
}))

const updater = vi.hoisted(() => ({
  check: vi.fn(),
  currentVersion: vi.fn(),
  available: vi.fn(),
}))

vi.mock("@/components/workspace/use-settings-store", () => ({
  useSettingsStore: (select: (state: unknown) => unknown) =>
    select({ prefs: { updates: settings.updates }, setPrefs: settings.setPrefs }),
}))

vi.mock("@/lib/app-updater", () => ({
  checkForAppUpdate: updater.check,
  getCurrentAppVersion: updater.currentVersion,
  isAppUpdaterAvailable: updater.available,
}))

vi.mock("../tiptap/external-open", () => ({ openWebAddressInBrowser: vi.fn() }))

function availableUpdate() {
  return {
    currentVersion: "0.1.9",
    version: "0.2.0",
    notes: null,
    install: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }
}

function channelSelect() {
  return screen.getByRole("combobox", { name: "Канал обновлений" })
}

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  settings.updates = { autoUpdate: true, channel: "stable" }
  settings.setPrefs.mockReset()
  settings.setPrefs.mockImplementation(async (patch: { updates?: typeof settings.updates }) => {
    if (patch.updates) settings.updates = { ...settings.updates, ...patch.updates }
  })
  updater.check.mockReset().mockResolvedValue(null)
  updater.currentVersion.mockReset().mockResolvedValue("0.1.9")
  updater.available.mockReset().mockReturnValue(true)
})

afterEach(cleanup)

describe("update channel preference", () => {
  it("offers stable by default and explains what each channel receives", async () => {
    render(<UpdateSettings />)
    expect(selectedText("Канал обновлений")).toBe("Стабильный")
    expect(screen.getByText(/только финальные стабильные версии/i)).toBeTruthy()

    fireEvent.click(channelSelect())
    expect(await screen.findByRole("option", { name: "Стабильный" })).toBeTruthy()
    fireEvent.click(screen.getByRole("option", { name: "Бета" }))
    expect(screen.getByText(/бета-версии и последующие финальные/i)).toBeTruthy()
    expect(
      screen.getByText(/при возврате на стабильный канал откат не устанавливается/i),
    ).toBeTruthy()
  })

  it("persists a selected channel together with the current automatic-update setting", async () => {
    render(<UpdateSettings />)
    await chooseOption("Канал обновлений", "Бета")

    await waitFor(() =>
      expect(settings.setPrefs).toHaveBeenCalledWith({
        updates: { autoUpdate: true, channel: "beta" },
      }),
    )
    expect(settings.updates).toEqual({ autoUpdate: true, channel: "beta" })
  })

  it("preserves the selected channel when automatic updates are toggled", async () => {
    settings.updates = { autoUpdate: true, channel: "beta" }
    render(<UpdateSettings />)
    fireEvent.click(screen.getByRole("switch"))

    await waitFor(() =>
      expect(settings.setPrefs).toHaveBeenCalledWith({
        updates: { autoUpdate: false, channel: "beta" },
      }),
    )
  })

  it("checks the selected channel and discards an already found update after switching", async () => {
    const update = availableUpdate()
    updater.check.mockResolvedValue(update)
    render(<UpdateSettings />)
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }))
    await screen.findByRole("button", { name: /Установить 0\.2\.0/ })
    expect(updater.check).toHaveBeenCalledWith("stable")

    await chooseOption("Канал обновлений", "Бета")
    await waitFor(() => expect(update.close).toHaveBeenCalledOnce())
    expect(screen.queryByRole("button", { name: /Установить 0\.2\.0/ })).toBeNull()
    expect(update.install).not.toHaveBeenCalled()
  })

  it("closes and ignores a stale result when another window changes the channel mid-check", async () => {
    let resolveCheck: (value: ReturnType<typeof availableUpdate>) => void = () => {}
    updater.check.mockReturnValue(
      new Promise((resolve) => {
        resolveCheck = resolve
      }),
    )
    const view = render(<UpdateSettings />)
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }))
    await screen.findByText(/Проверяем GitHub Releases/)

    settings.updates = { autoUpdate: true, channel: "beta" }
    view.rerender(<UpdateSettings />)
    const staleUpdate = availableUpdate()
    resolveCheck(staleUpdate)

    await waitFor(() => expect(staleUpdate.close).toHaveBeenCalledOnce())
    expect(updater.check).toHaveBeenCalledWith("stable")
    expect(screen.queryByRole("button", { name: /Установить 0\.2\.0/ })).toBeNull()
    expect(staleUpdate.install).not.toHaveBeenCalled()
  })

  it("closes a late update result when the settings panel unmounts during a check", async () => {
    let resolveCheck: (value: ReturnType<typeof availableUpdate>) => void = () => {}
    updater.check.mockReturnValue(
      new Promise((resolve) => {
        resolveCheck = resolve
      }),
    )
    const view = render(<UpdateSettings />)
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }))
    await screen.findByText(/Проверяем GitHub Releases/)
    view.unmount()

    const lateUpdate = availableUpdate()
    resolveCheck(lateUpdate)
    await waitFor(() => expect(lateUpdate.close).toHaveBeenCalledOnce())
    expect(lateUpdate.install).not.toHaveBeenCalled()
  })

  it("discards an available update when another window changes the channel", async () => {
    const staleUpdate = availableUpdate()
    updater.check.mockResolvedValue(staleUpdate)
    const view = render(<UpdateSettings />)
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }))
    await screen.findByRole("button", { name: /Установить 0\.2\.0/ })

    settings.updates = { autoUpdate: true, channel: "beta" }
    view.rerender(<UpdateSettings />)

    await waitFor(() => expect(staleUpdate.close).toHaveBeenCalledOnce())
    expect(screen.queryByRole("button", { name: /Установить 0\.2\.0/ })).toBeNull()
    expect(staleUpdate.install).not.toHaveBeenCalled()
  })

  it("keeps an already running install alive if another window changes the channel", async () => {
    let finishInstall: (() => void) | undefined
    const update = availableUpdate()
    update.install.mockImplementation(
      () => new Promise<void>((resolve) => (finishInstall = resolve)),
    )
    updater.check.mockResolvedValue(update)
    const view = render(<UpdateSettings />)
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }))
    await screen.findByRole("button", { name: /Установить 0\.2\.0/ })
    fireEvent.click(screen.getByRole("button", { name: /Установить 0\.2\.0/ }))
    await waitFor(() => expect(update.install).toHaveBeenCalledOnce())

    settings.updates = { autoUpdate: true, channel: "beta" }
    view.rerender(<UpdateSettings />)
    expect(update.close).not.toHaveBeenCalled()

    finishInstall?.()
  })
})
