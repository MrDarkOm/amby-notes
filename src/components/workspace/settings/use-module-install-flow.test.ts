// @vitest-environment happy-dom
import * as React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"
import { logger } from "@/lib/logger"
import { installFailureText } from "@/lib/modules/package-manager/install-errors"
import { MODULE_REGISTRY } from "../modules"
import { useModuleInstallFlow } from "./use-module-install-flow"

const mocks = vi.hoisted(() => ({ install: vi.fn() }))
vi.mock("@/lib/modules/package-manager/catalog-install", () => ({
  installCatalogModule: mocks.install,
}))

const [first, second] = MODULE_REGISTRY

function setup() {
  const applyPreset = vi.fn(async () => {})
  const applyModuleToggle = vi.fn(async () => {})
  const hook = renderHook(() => {
    const [installed, setInstalled] = React.useState<Set<string>>(new Set())
    const flow = useModuleInstallFlow({
      installedModuleIds: installed,
      setInstalledModuleIds: setInstalled,
      applyPreset,
      applyModuleToggle,
    })
    return { flow, installed }
  })
  return { hook, applyPreset, applyModuleToggle }
}

beforeEach(() => {
  mocks.install.mockReset().mockResolvedValue({ result: { success: true }, targetVersion: "1.0.0" })
  vi.spyOn(logger, "warn").mockImplementation(() => null)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("useModuleInstallFlow", () => {
  it("opens and cancels the not-installed dialog for one module", () => {
    const { hook } = setup()
    act(() => hook.result.current.flow.askToInstall(first))
    expect(hook.result.current.flow.notInstalledModalOpen).toBe(true)
    expect(hook.result.current.flow.pendingInstallModule).toBe(first)

    act(() => hook.result.current.flow.cancelInstall())
    expect(hook.result.current.flow.notInstalledModalOpen).toBe(false)
    expect(hook.result.current.flow.pendingInstallModule).toBeNull()
  })

  it("installs one module, marks it installed and switches it on", async () => {
    const { hook, applyModuleToggle } = setup()
    act(() => hook.result.current.flow.askToInstall(first))
    await act(() => hook.result.current.flow.downloadAndEnablePending())

    expect(mocks.install).toHaveBeenCalledTimes(1)
    expect(hook.result.current.flow.isInstalled(first.id)).toBe(true)
    expect(applyModuleToggle).toHaveBeenCalledWith(first.id, true)
    expect(hook.result.current.flow.notInstalledModalOpen).toBe(false)
    expect(hook.result.current.flow.isInstallingPending).toBe(false)
  })

  it("keeps the dialog open with the failure text when one module fails", async () => {
    mocks.install.mockResolvedValue({
      result: { success: false, error: "/Users/alice/x", errorCode: "STAGING_FAILED" },
      targetVersion: "1.0.0",
    })
    const { hook, applyModuleToggle } = setup()
    act(() => hook.result.current.flow.askToInstall(first))
    await act(() => hook.result.current.flow.downloadAndEnablePending())

    expect(hook.result.current.flow.installError).toBe(installFailureText("STAGING_FAILED"))
    expect(hook.result.current.flow.notInstalledModalOpen).toBe(true)
    expect(hook.result.current.flow.isInstalled(first.id)).toBe(false)
    expect(applyModuleToggle).not.toHaveBeenCalled()
  })

  it("installs every missing module of a preset, then applies the preset", async () => {
    const { hook, applyPreset } = setup()
    act(() =>
      hook.result.current.flow.askToInstallForPreset({
        presetId: "standard",
        presetLabel: "Standard",
        missingModules: [first, second],
      }),
    )
    expect(hook.result.current.flow.missingPresetModalOpen).toBe(true)

    await act(() => hook.result.current.flow.downloadAllMissing())

    expect(mocks.install).toHaveBeenCalledTimes(2)
    expect(hook.result.current.flow.isInstalled(first.id)).toBe(true)
    expect(hook.result.current.flow.isInstalled(second.id)).toBe(true)
    expect(applyPreset).toHaveBeenCalledWith("standard")
    expect(hook.result.current.flow.missingPresetModalOpen).toBe(false)
    expect(hook.result.current.flow.downloadProgress).toBeNull()
    expect(hook.result.current.flow.isDownloadingMissing).toBe(false)
  })

  it("stops at the first failed module, keeps the earlier ones installed and does not apply", async () => {
    mocks.install
      .mockResolvedValueOnce({ result: { success: true }, targetVersion: "1.0.0" })
      .mockResolvedValueOnce({
        result: { success: false, error: "boom", errorCode: "STAGING_FAILED" },
        targetVersion: "1.0.0",
      })
    const { hook, applyPreset } = setup()
    act(() =>
      hook.result.current.flow.askToInstallForPreset({
        presetId: "standard",
        presetLabel: "Standard",
        missingModules: [first, second],
      }),
    )
    await act(() => hook.result.current.flow.downloadAllMissing())

    expect(hook.result.current.flow.installError).toBe(installFailureText("STAGING_FAILED"))
    expect(hook.result.current.flow.isInstalled(first.id)).toBe(true)
    expect(hook.result.current.flow.isInstalled(second.id)).toBe(false)
    expect(hook.result.current.flow.missingPresetModalOpen).toBe(true)
    expect(applyPreset).not.toHaveBeenCalled()
  })

  it("closing the preset dialog forgets the target", () => {
    const { hook } = setup()
    act(() =>
      hook.result.current.flow.askToInstallForPreset({
        presetId: "standard",
        presetLabel: "Standard",
        missingModules: [first],
      }),
    )
    act(() => hook.result.current.flow.onMissingPresetOpenChange(false))
    expect(hook.result.current.flow.missingPresetModalOpen).toBe(false)
    expect(hook.result.current.flow.pendingPresetTarget).toBeNull()
  })
})
