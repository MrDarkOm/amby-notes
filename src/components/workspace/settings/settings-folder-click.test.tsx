// @vitest-environment happy-dom
// The switch «Клик по папке разворачивает её» in the «Файлы» group (TREE-02).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { FolderClickSetting } from "./settings-data"

const settings = vi.hoisted(() => ({
  folderClickToggles: false,
  setPrefs: vi.fn(),
}))

vi.mock("@/components/workspace/use-settings-store", () => ({
  useSettingsStore: (select: (state: unknown) => unknown) =>
    select({
      prefs: { files: { deleteMode: "archive", folderClickToggles: settings.folderClickToggles } },
      setPrefs: settings.setPrefs,
    }),
}))

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  settings.folderClickToggles = false
  settings.setPrefs.mockReset().mockResolvedValue(undefined)
})
afterEach(cleanup)

describe("TREE-02: folder click setting", () => {
  it("is off by default and saves the switch next to the other file preferences", () => {
    render(<FolderClickSetting />)
    const toggle = screen.getByRole("switch")
    expect(toggle.getAttribute("aria-checked")).toBe("false")
    fireEvent.click(toggle)
    expect(settings.setPrefs).toHaveBeenCalledWith({
      files: { deleteMode: "archive", folderClickToggles: true },
    })
  })

  it("shows its label in Russian and English", async () => {
    render(<FolderClickSetting />)
    expect(screen.getByText("Клик по папке разворачивает её")).toBeTruthy()
    cleanup()
    await i18n.changeLanguage("en")
    render(<FolderClickSetting />)
    expect(screen.getByText("Clicking a folder expands it")).toBeTruthy()
  })
})
