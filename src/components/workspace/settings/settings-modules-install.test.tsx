// @vitest-environment happy-dom
// MOD-05: a failed «download and enable» in the module list tells the person and writes the debug log,
// the same way the package manager does; it is not a lone console.error.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { logger } from "@/lib/logger"
import { chooseOption } from "@/lib/test-utils/amby-select"
import { installFailureText } from "@/lib/modules/package-manager/install-errors"
import { ModulesTab } from "./settings-modules"

const mocks = vi.hoisted(() => ({
  install: vi.fn(),
  catalog: vi.fn(),
}))

vi.mock("../app-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app-config")>()),
  loadSettings: vi.fn(async () => ({})),
  loadWorkspaceConfig: vi.fn(async () => ({
    customPresets: [
      { id: "mine", label: "Mine", builtin: false, locked: false, activeModules: [] },
    ],
    layout: { activePresetId: "mine" },
    profile: { id: "custom" },
  })),
  saveSettingsPatch: vi.fn(async () => {}),
  saveWorkspaceConfigPatch: vi.fn(async () => {}),
}))
vi.mock("@/lib/modules/global-registry", () => ({
  loadGlobalModulesRegistry: vi.fn(async () => ({ installed: {} })),
}))
vi.mock("@/lib/modules/package-manager/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules/package-manager/catalog")>()),
  getCatalogModule: mocks.catalog,
}))
vi.mock("@/lib/modules/package-manager/installer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules/package-manager/installer")>()),
  installFromRemoteUrl: mocks.install,
}))

function renderTab() {
  return render(
    <ModulesTab
      activeModules={[]}
      onModuleEnabledChange={vi.fn()}
      selectedId="tags"
      onSelectedChange={vi.fn()}
    />,
  )
}

beforeEach(async () => {
  await i18n.changeLanguage("en")
  mocks.catalog.mockReset().mockResolvedValue(null)
  mocks.install.mockReset().mockResolvedValue({
    success: false,
    moduleId: "x",
    error: "ENOENT /Users/alice/secret",
    errorCode: "STAGING_FAILED",
  })
  vi.spyOn(logger, "warn").mockImplementation(() => null)
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("MOD-05: failed install from the module list", () => {
  it("download and enable of one module shows the failure text and logs its code", async () => {
    renderTab()
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Module Presets" })).toBeTruthy(),
    )
    fireEvent.click((await screen.findAllByRole("switch"))[0])
    fireEvent.click(await screen.findByRole("button", { name: "Download and Enable" }))

    const text = installFailureText("STAGING_FAILED")
    await waitFor(() => expect(screen.getByText(text)).toBeTruthy())
    expect(screen.queryByText(/alice/)).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(
      "modules.install_failed",
      expect.objectContaining({ failureCode: "STAGING_FAILED" }),
    )
  })

  it("download of the modules a preset needs shows the failure text and logs its code", async () => {
    renderTab()
    await chooseOption("Module Presets", /Standard/)
    fireEvent.click(await screen.findByRole("button", { name: "Download All" }))

    const text = installFailureText("STAGING_FAILED")
    await waitFor(() => expect(screen.getByText(text)).toBeTruthy())
    expect(screen.queryByText(/alice/)).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(
      "modules.install_failed",
      expect.objectContaining({ failureCode: "STAGING_FAILED" }),
    )
  })
})
