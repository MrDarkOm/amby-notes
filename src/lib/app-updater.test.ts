import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DownloadEvent } from "@tauri-apps/plugin-updater"
import { calculateDownloadPercent } from "./app-updater"

const native = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  getCurrentWindow: vi.fn(() => ({ label: "main" })),
  getBundleType: vi.fn(),
  check: vi.fn(),
  relaunch: vi.fn(),
  confirmAction: vi.fn(),
  warn: vi.fn(),
}))

vi.mock("@/lib/storage", () => ({
  isTauri: native.isTauri,
  confirmAction: native.confirmAction,
}))
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: native.getCurrentWindow }))
vi.mock("@tauri-apps/api/app", () => ({ getBundleType: native.getBundleType }))
vi.mock("@tauri-apps/plugin-updater", () => ({ check: native.check }))
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: native.relaunch }))
vi.mock("@/lib/logger", () => ({
  logger: { warn: native.warn },
  errorType: (error: unknown) => (error instanceof Error ? error.name : "UnknownError"),
}))

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.stubEnv("DEV", false)
  native.isTauri.mockReturnValue(true)
  native.getCurrentWindow.mockReturnValue({ label: "main" })
  native.getBundleType.mockResolvedValue("nsis")
  native.check.mockResolvedValue(null)
  native.relaunch.mockResolvedValue(undefined)
})

afterEach(() => vi.unstubAllEnvs())

function availableUpdate() {
  return {
    currentVersion: "0.1.5",
    version: "0.1.6",
    body: "Synthetic release notes",
    downloadAndInstall: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

describe("app updater progress", () => {
  it("reports a bounded whole-number percentage", () => {
    expect(calculateDownloadPercent(0, 200)).toBe(0)
    expect(calculateDownloadPercent(51, 200)).toBe(26)
    expect(calculateDownloadPercent(250, 200)).toBe(100)
    expect(calculateDownloadPercent(-10, 200)).toBe(0)
  })

  it("keeps progress indeterminate when the server omits the content length", () => {
    expect(calculateDownloadPercent(50)).toBeNull()
    expect(calculateDownloadPercent(50, 0)).toBeNull()
  })
})

describe("silent startup updates", () => {
  it.each(["app", "appimage"])(
    "waits for native installation before restarting on %s",
    async (bundleType) => {
      native.getBundleType.mockResolvedValue(bundleType)
      const update = availableUpdate()
      let finishInstall!: () => void
      update.downloadAndInstall.mockReturnValue(
        new Promise<void>((resolve) => (finishInstall = resolve)),
      )
      native.check.mockResolvedValue(update)
      const { runAutomaticAppUpdate } = await import("./app-updater")
      let result: string | undefined
      const task = runAutomaticAppUpdate().then((value) => (result = value))
      await vi.waitFor(() => expect(update.downloadAndInstall).toHaveBeenCalledOnce())
      expect(result).toBeUndefined()
      expect(native.relaunch).not.toHaveBeenCalled()
      expect(native.confirmAction).not.toHaveBeenCalled()
      finishInstall()
      await task
      expect(result).toBe("restarting")
      expect(native.relaunch).toHaveBeenCalledOnce()
    },
  )

  it.each(["deb", "rpm"])("never invokes package-manager password dialogs for %s", async (type) => {
    native.getBundleType.mockResolvedValue(type)
    const { runAutomaticAppUpdate } = await import("./app-updater")
    expect(await runAutomaticAppUpdate()).toBe("ready")
    expect(native.check).not.toHaveBeenCalled()
    expect(native.relaunch).not.toHaveBeenCalled()
    expect(native.confirmAction).not.toHaveBeenCalled()
  })

  it("opens without updating when the native bundle type cannot be read", async () => {
    native.getBundleType.mockRejectedValue(new Error("Synthetic unavailable bundle type"))
    const { runAutomaticAppUpdate } = await import("./app-updater")
    expect(await runAutomaticAppUpdate()).toBe("ready")
    expect(native.check).not.toHaveBeenCalled()
    expect(native.confirmAction).not.toHaveBeenCalled()
  })

  it("keeps manual updates available for an existing Linux package installation", async () => {
    native.getBundleType.mockResolvedValue("deb")
    const update = availableUpdate()
    native.check.mockResolvedValue(update)
    const { checkForAppUpdate } = await import("./app-updater")
    const manual = await checkForAppUpdate()
    await manual!.install()
    expect(update.downloadAndInstall).toHaveBeenCalledOnce()
    expect(native.getBundleType).not.toHaveBeenCalled()
  })

  it("checks endpoint connectivity with a short timeout and opens when current", async () => {
    const { runAutomaticAppUpdate } = await import("./app-updater")
    expect(await runAutomaticAppUpdate()).toBe("ready")
    expect(native.check).toHaveBeenCalledWith({ timeout: 5000 })
    expect(native.confirmAction).not.toHaveBeenCalled()
    expect(native.relaunch).not.toHaveBeenCalled()
  })

  it("installs and restarts without asking or opening the old workspace", async () => {
    const update = availableUpdate()
    native.check.mockResolvedValue(update)
    const { runAutomaticAppUpdate } = await import("./app-updater")

    expect(await runAutomaticAppUpdate()).toBe("restarting")
    expect(update.downloadAndInstall).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 600_000,
      restartAfterInstall: true,
    })
    expect(native.relaunch).toHaveBeenCalledOnce()
    expect(update.close).toHaveBeenCalledOnce()
    expect(native.confirmAction).not.toHaveBeenCalled()
  })

  it("shares an in-flight check and install across repeated startup calls", async () => {
    const update = availableUpdate()
    let finishCheck!: (result: ReturnType<typeof availableUpdate>) => void
    native.check.mockReturnValue(new Promise((resolve) => (finishCheck = resolve)))
    const { runAutomaticAppUpdate } = await import("./app-updater")
    const first = runAutomaticAppUpdate()
    const second = runAutomaticAppUpdate()
    expect(second).toBe(first)
    await vi.waitFor(() => expect(native.check).toHaveBeenCalledOnce())
    expect(update.downloadAndInstall).not.toHaveBeenCalled()
    finishCheck(update)
    expect(await first).toBe("restarting")
    expect(await second).toBe("restarting")
    expect(update.downloadAndInstall).toHaveBeenCalledOnce()
    expect(native.relaunch).toHaveBeenCalledOnce()
  })

  it("opens offline without a popup and retries only on a new launch", async () => {
    native.check.mockRejectedValue(new Error("Synthetic network failure"))
    const { runAutomaticAppUpdate } = await import("./app-updater")
    expect(await runAutomaticAppUpdate()).toBe("ready")
    expect(await runAutomaticAppUpdate()).toBe("ready")
    expect(native.check).toHaveBeenCalledOnce()
    expect(native.confirmAction).not.toHaveBeenCalled()
    expect(native.warn).toHaveBeenCalledWith("updater.automatic_update_failed", {
      errorType: "Error",
    })
  })

  it("opens the existing version if download or signature verification fails", async () => {
    const update = availableUpdate()
    update.downloadAndInstall.mockRejectedValue(new Error("Synthetic rejected update"))
    native.check.mockResolvedValue(update)
    const { runAutomaticAppUpdate } = await import("./app-updater")
    expect(await runAutomaticAppUpdate()).toBe("ready")
    expect(update.close).toHaveBeenCalledOnce()
    expect(native.relaunch).not.toHaveBeenCalled()
    expect(native.confirmAction).not.toHaveBeenCalled()
  })

  it("opens if restarting fails and still releases the update resource", async () => {
    const update = availableUpdate()
    native.check.mockResolvedValue(update)
    native.relaunch.mockRejectedValue(new Error("Synthetic restart failure"))
    const { runAutomaticAppUpdate } = await import("./app-updater")
    expect(await runAutomaticAppUpdate()).toBe("ready")
    expect(update.close).toHaveBeenCalledOnce()
  })

  it("does not reopen the old workspace when releasing the resource fails", async () => {
    const update = availableUpdate()
    native.check.mockResolvedValue(update)
    update.close.mockRejectedValue(new Error("Synthetic closed process"))
    const { runAutomaticAppUpdate } = await import("./app-updater")
    expect(await runAutomaticAppUpdate()).toBe("restarting")
  })

  it.each(["settings", "note-secondary"])("skips a secondary window: %s", async (label) => {
    native.getCurrentWindow.mockReturnValue({ label })
    const { runAutomaticAppUpdate } = await import("./app-updater")
    expect(await runAutomaticAppUpdate()).toBe("ready")
    expect(native.check).not.toHaveBeenCalled()
  })

  it("skips browser startup", async () => {
    native.isTauri.mockReturnValue(false)
    const { runAutomaticAppUpdate } = await import("./app-updater")
    expect(await runAutomaticAppUpdate()).toBe("ready")
    expect(native.check).not.toHaveBeenCalled()
  })

  it("skips development so installed releases never replace the dev executable", async () => {
    vi.stubEnv("DEV", true)
    const { runAutomaticAppUpdate } = await import("./app-updater")
    expect(await runAutomaticAppUpdate()).toBe("ready")
    expect(native.check).not.toHaveBeenCalled()
  })

  it("preserves manual checks and progress reporting", async () => {
    const update = availableUpdate()
    update.downloadAndInstall.mockImplementation(async (report: (event: DownloadEvent) => void) => {
      report({ event: "Started", data: { contentLength: 200 } })
      report({ event: "Progress", data: { chunkLength: 100 } })
      report({ event: "Finished" })
    })
    native.check.mockResolvedValue(update)
    const { checkForAppUpdate } = await import("./app-updater")
    const manual = await checkForAppUpdate()
    expect(native.check).toHaveBeenCalledWith({ timeout: 30_000 })
    const progress = vi.fn()
    await manual!.install(progress)
    expect(progress.mock.calls.map(([value]) => value)).toEqual([
      { phase: "downloading", percent: 0 },
      { phase: "downloading", percent: 50 },
      { phase: "installing" },
      { phase: "restarting" },
    ])
  })
})
