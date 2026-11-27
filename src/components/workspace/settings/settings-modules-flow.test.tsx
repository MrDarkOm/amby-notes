// @vitest-environment happy-dom
// MOD-06: what the module list does when a module or a preset needs a download. These pin the
// behaviour of the install dialogs (success, cancel, already installed) before and after the flow
// moved into `useModuleInstallFlow`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { chooseOption } from "@/lib/test-utils/amby-select"
import { STANDARD_MODULES, toCanonicalModuleId, toShortModuleId } from "@/lib/modules"
import { ModulesTab } from "./settings-modules"

const mocks = vi.hoisted(() => ({
  install: vi.fn(),
  catalog: vi.fn(),
  registry: vi.fn(),
  save: vi.fn(),
  config: vi.fn(),
}))

vi.mock("../app-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app-config")>()),
  loadSettings: vi.fn(async () => ({})),
  loadWorkspaceConfig: mocks.config,
  saveSettingsPatch: vi.fn(async () => {}),
  saveWorkspaceConfigPatch: mocks.save,
}))
vi.mock("@/lib/modules/global-registry", () => ({
  loadGlobalModulesRegistry: mocks.registry,
}))
vi.mock("@/lib/modules/package-manager/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules/package-manager/catalog")>()),
  getCatalogModule: mocks.catalog,
}))
vi.mock("@/lib/modules/package-manager/installer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules/package-manager/installer")>()),
  installFromRemoteUrl: mocks.install,
}))

function renderTab(overrides: { activeModules?: string[] } = {}) {
  const onModuleEnabledChange = vi.fn()
  const onPresetChange = vi.fn()
  render(
    <ModulesTab
      activeModules={overrides.activeModules ?? []}
      onModuleEnabledChange={onModuleEnabledChange}
      onPresetChange={onPresetChange}
      selectedId="tags"
      onSelectedChange={vi.fn()}
    />,
  )
  return { onModuleEnabledChange, onPresetChange }
}

async function ready() {
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Module Presets" })).toBeTruthy())
}

beforeEach(async () => {
  await i18n.changeLanguage("en")
  mocks.catalog.mockReset().mockResolvedValue(null)
  mocks.install.mockReset().mockResolvedValue({ success: true, moduleId: "x" })
  mocks.registry.mockReset().mockResolvedValue({ installed: {} })
  mocks.save.mockReset().mockResolvedValue(undefined)
  mocks.config.mockReset().mockResolvedValue({
    customPresets: [
      { id: "mine", label: "Mine", builtin: false, locked: false, activeModules: [] },
    ],
    layout: { activePresetId: "mine" },
    profile: { id: "custom" },
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("MOD-06: install dialogs of the module list", () => {
  it("download and enable installs one module, closes the dialog and switches it on", async () => {
    const { onModuleEnabledChange } = renderTab()
    await ready()
    fireEvent.click((await screen.findAllByRole("switch"))[0])
    fireEvent.click(await screen.findByRole("button", { name: "Download and Enable" }))

    await waitFor(() => expect(onModuleEnabledChange).toHaveBeenCalledTimes(1))
    expect(onModuleEnabledChange.mock.calls[0][1]).toBe(true)
    expect(mocks.install).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Download and Enable" })).toBeNull(),
    )
  })

  it("cancel in the not-installed dialog installs nothing and switches nothing", async () => {
    const { onModuleEnabledChange } = renderTab()
    await ready()
    fireEvent.click((await screen.findAllByRole("switch"))[0])
    await screen.findByRole("button", { name: "Download and Enable" })
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Download and Enable" })).toBeNull(),
    )
    expect(mocks.install).not.toHaveBeenCalled()
    expect(onModuleEnabledChange).not.toHaveBeenCalled()
  })

  it("a module that is already installed switches on without a dialog", async () => {
    const all = Object.fromEntries(
      [...STANDARD_MODULES, "tags"].map((id) => [toCanonicalModuleId(id), {}]),
    )
    mocks.registry.mockResolvedValue({ installed: all })
    const { onModuleEnabledChange } = renderTab()
    await ready()
    await waitFor(() => expect(mocks.registry).toHaveBeenCalled())
    fireEvent.click((await screen.findAllByRole("switch"))[0])

    await waitFor(() => expect(onModuleEnabledChange).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole("button", { name: "Download and Enable" })).toBeNull()
    expect(mocks.install).not.toHaveBeenCalled()
  })

  it("download all installs every missing module of the preset and then applies it", async () => {
    const { onPresetChange } = renderTab()
    await ready()
    await chooseOption("Module Presets", /Standard/)
    fireEvent.click(await screen.findByRole("button", { name: "Download All" }))

    await waitFor(() => expect(onPresetChange).toHaveBeenCalledWith("standard"))
    expect(mocks.install.mock.calls.length).toBeGreaterThan(0)
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ profile: { id: "standard" } }),
    )
    await waitFor(() => expect(screen.queryByRole("button", { name: "Download All" })).toBeNull())
  })

  it("cancel in the missing-modules dialog applies nothing", async () => {
    const { onPresetChange } = renderTab()
    await ready()
    await chooseOption("Module Presets", /Standard/)
    await screen.findByRole("button", { name: "Download All" })
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    await waitFor(() => expect(screen.queryByRole("button", { name: "Download All" })).toBeNull())
    expect(mocks.install).not.toHaveBeenCalled()
    expect(onPresetChange).not.toHaveBeenCalled()
  })

  it("a built-in preset asks for a custom copy before a module is switched", async () => {
    mocks.config.mockResolvedValue({
      customPresets: [],
      layout: { activePresetId: "standard" },
      profile: { id: "standard" },
    })
    const { onModuleEnabledChange, onPresetChange } = renderTab({
      activeModules: STANDARD_MODULES.map(toShortModuleId),
    })
    await ready()
    fireEvent.click((await screen.findAllByRole("switch"))[0])
    fireEvent.click(await screen.findByRole("button", { name: "Create Custom Preset" }))

    await waitFor(() => expect(onModuleEnabledChange).toHaveBeenCalledTimes(1))
    expect(onPresetChange.mock.calls[0][0]).toMatch(/^custom-/)
  })
})
