// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import { ProjectOperationError } from "@/lib/storage"

const openVault = vi.hoisted(() => vi.fn())
const resolveWorkshopFolder = vi.hoisted(() => vi.fn())
const config = vi.hoisted(() => ({ saved: {} as Record<string, unknown> }))

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  openVault,
  resolveWorkshopFolder,
  isTauri: () => false,
}))
vi.mock("../app-config", () => ({
  loadWorkspaceConfig: async () => ({ moduleSettings: config.saved }),
  saveWorkspaceConfigPatch: async (patch: { moduleSettings: Record<string, unknown> }) => {
    config.saved = patch.moduleSettings
  },
}))

import { CreativeSettings } from "./creative-settings"
import { useCreativeSettingsStore } from "./creative-settings-store"

describe("CreativeSettings: the workshop folder", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    config.saved = {}
    openVault.mockReset()
    resolveWorkshopFolder.mockReset()
    useCreativeSettingsStore.setState({ showInTree: true, workshopPath: null })
  })
  afterEach(cleanup)

  it("shows the localized default until a folder is chosen", async () => {
    render(<CreativeSettings />)
    expect(screen.getByTestId("workshop-folder").textContent).toBe("Мастерская")
    expect(screen.queryByRole("button", { name: "По умолчанию" })).toBeNull()
    await act(async () => i18n.changeLanguage("en"))
    expect(screen.getByTestId("workshop-folder").textContent).toBe("Workshop")
  })

  it("takes the folder from the app's dialog through the backend and saves it", async () => {
    openVault.mockResolvedValue("/vault/Книги/Моя")
    resolveWorkshopFolder.mockResolvedValue("Книги/Моя")
    render(<CreativeSettings />)
    fireEvent.click(screen.getByRole("button", { name: "Выбрать…" }))
    await waitFor(() => expect(screen.getByTestId("workshop-folder").textContent).toBe("Книги/Моя"))
    expect(resolveWorkshopFolder).toHaveBeenCalledWith("/vault/Книги/Моя")
    expect(config.saved).toEqual({ creative: { workshopPath: "Книги/Моя" } })
    // It moved no files: the settings only name the folder.
    fireEvent.click(screen.getByRole("button", { name: "По умолчанию" }))
    await waitFor(() =>
      expect(screen.getByTestId("workshop-folder").textContent).toBe("Мастерская"),
    )
  })

  it("says why a folder outside the vault was not taken and keeps the old one", async () => {
    openVault.mockResolvedValue("/elsewhere")
    resolveWorkshopFolder.mockRejectedValue(
      new ProjectOperationError("invalidParent", "outside", {
        kind: "invalidParent",
        reason: "the folder is outside the vault",
      }),
    )
    render(<CreativeSettings />)
    fireEvent.click(screen.getByRole("button", { name: "Выбрать…" }))
    expect((await screen.findByRole("alert")).textContent).toContain("Папка не выбрана")
    expect(screen.getByTestId("workshop-folder").textContent).toBe("Мастерская")
    expect(config.saved).toEqual({})
  })

  it("does nothing when the dialog is cancelled", async () => {
    openVault.mockResolvedValue(null)
    render(<CreativeSettings />)
    fireEvent.click(screen.getByRole("button", { name: "Выбрать…" }))
    await waitFor(() => expect(openVault).toHaveBeenCalled())
    expect(resolveWorkshopFolder).not.toHaveBeenCalled()
    expect(screen.queryByRole("alert")).toBeNull()
  })
})
