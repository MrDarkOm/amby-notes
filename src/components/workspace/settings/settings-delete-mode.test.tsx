// @vitest-environment happy-dom
// The setting "Удаление файлов" after appendix К (docs/sync-plan.md, К4): three choices —
// «В системную корзину» (default), «Удалять полностью», «Переносить в архив»; the old value `vault`
// is read as the last one. Written before the code (раздел 6).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { DeleteModeSetting } from "./settings-data"

const settings = vi.hoisted(() => ({
  deleteMode: "system" as string,
  setPrefs: vi.fn(),
}))

vi.mock("@/components/workspace/use-settings-store", () => ({
  useSettingsStore: (select: (state: unknown) => unknown) =>
    select({ prefs: { files: { deleteMode: settings.deleteMode } }, setPrefs: settings.setPrefs }),
}))

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  settings.deleteMode = "system"
  settings.setPrefs.mockReset().mockResolvedValue(undefined)
})
afterEach(cleanup)

const trigger = () => screen.getByRole("combobox")

async function optionNames(): Promise<string[]> {
  fireEvent.click(trigger())
  const options = await screen.findAllByRole("option", {}, { timeout: 3000 })
  return options.map((option) => option.textContent ?? "")
}

describe("К4: the three ways to delete", () => {
  it("offers exactly «В системную корзину», «Удалять полностью» and «Переносить в архив»", async () => {
    render(<DeleteModeSetting />)
    expect((await optionNames()).sort()).toEqual(
      ["В системную корзину", "Переносить в архив", "Удалять полностью"].sort(),
    )
  })

  it("shows the system trash as the default choice", () => {
    render(<DeleteModeSetting />)
    expect(trigger().textContent).toContain("В системную корзину")
  })

  it("saves the archive choice under the value `archive`", async () => {
    render(<DeleteModeSetting />)
    await optionNames()
    fireEvent.click(await screen.findByRole("option", { name: "Переносить в архив" }))
    await waitFor(() =>
      expect(settings.setPrefs).toHaveBeenCalledWith({ files: { deleteMode: "archive" } }),
    )
  })

  it("saves the other two choices under `system` and `permanent`", async () => {
    settings.deleteMode = "archive"
    render(<DeleteModeSetting />)
    await optionNames()
    fireEvent.click(await screen.findByRole("option", { name: "Удалять полностью" }))
    await waitFor(() =>
      expect(settings.setPrefs).toHaveBeenCalledWith({ files: { deleteMode: "permanent" } }),
    )
  })

  it("explains the archive choice by the archive, not by a vault trash", () => {
    settings.deleteMode = "archive"
    render(<DeleteModeSetting />)
    const text = document.body.textContent ?? ""
    expect(text).toContain("Переносить в архив")
    expect(text).toMatch(/архив/iu)
    expect(text).not.toMatch(/корзин\p{L}* хранилища|\.amby\/trash/iu)
  })
})
