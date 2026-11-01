// @vitest-environment happy-dom
import { renderHook, waitFor, act } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import { usePresets } from "./use-presets"
import * as config from "./app-config"

vi.mock("./app-config", async (original) => ({
  ...(await original<typeof import("./app-config")>()),
  loadSettings: vi.fn(),
  loadLayout: vi.fn(),
  loadWorkspaceConfig: vi.fn(),
  saveLayout: vi.fn().mockResolvedValue(undefined),
  saveSettingsPatch: vi.fn().mockResolvedValue(undefined),
  saveWorkspaceActivePreset: vi.fn().mockResolvedValue(undefined),
  saveWorkspaceConfigPatch: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@/lib/modules", async (original) => ({
  ...(await original<typeof import("@/lib/modules")>()),
  getInstalledModuleIds: vi.fn(),
  isModuleInstalled: vi.fn().mockResolvedValue(true),
  moduleHost: { syncWithWorkspace: vi.fn().mockResolvedValue(undefined) },
}))

import * as modules from "@/lib/modules"

const custom = {
  id: "custom-1",
  label: "Mine",
  activeModules: ["tags", "creative"],
  layout: [],
  activeBySide: { left: "files" as const, right: null },
}
const everything = new Set(
  [
    "tags",
    "favorites",
    "databases",
    "history",
    "links",
    "graph",
    "ai",
    "excalidraw",
    "creative",
  ].map((id) => `amby.${id}`),
)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(config.loadSettings).mockResolvedValue({ panelScope: "global" } as never)
  vi.mocked(modules.getInstalledModuleIds).mockResolvedValue(everything)
})

describe("usePresets", () => {
  it("runs the preset the vault file names, not an older one left in the global layout", async () => {
    // The settings window records its choice in the vault file; the global layout still says Standard.
    vi.mocked(config.loadLayout).mockResolvedValue({
      activePresetId: "standard",
      activeModules: ["tags"],
      buttons: null,
      activeBySide: null,
    } as never)
    vi.mocked(config.loadWorkspaceConfig).mockResolvedValue({
      customPresets: [custom],
      layout: { activePresetId: "custom-1" },
      enabledModules: ["amby.tags", "amby.creative"],
    } as never)
    const { result } = renderHook(() => usePresets("/vault"))
    await waitFor(() => expect(result.current.activePresetId).toBe("custom-1"))
    expect(result.current.activeModules).toEqual(["tags", "creative"])
  })

  it("mirrors the running preset into the vault file", async () => {
    vi.mocked(config.loadLayout).mockResolvedValue({ activePresetId: "standard" } as never)
    vi.mocked(config.loadWorkspaceConfig).mockResolvedValue({
      customPresets: [],
      layout: {},
      enabledModules: undefined,
    } as never)
    renderHook(() => usePresets("/vault"))
    await waitFor(() =>
      expect(config.saveWorkspaceActivePreset).toHaveBeenCalledWith("standard", expect.any(Array)),
    )
  })

  it("takes a preset the settings window chose, with the vault's current presets", async () => {
    vi.mocked(config.loadLayout).mockResolvedValue({ activePresetId: "standard" } as never)
    const workspace = { customPresets: [] as unknown[], layout: {}, enabledModules: undefined }
    vi.mocked(config.loadWorkspaceConfig).mockResolvedValue(workspace as never)
    const { result } = renderHook(() => usePresets("/vault"))
    await waitFor(() => expect(result.current.activePresetId).toBe("standard"))
    workspace.customPresets = [custom]
    await act(async () => {
      await result.current.adoptPreset("custom-1")
    })
    expect(result.current.activePresetId).toBe("custom-1")
    expect(result.current.presets.some((preset) => preset.id === "custom-1")).toBe(true)
  })
})
