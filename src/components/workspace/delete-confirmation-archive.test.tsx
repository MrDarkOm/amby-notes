// @vitest-environment happy-dom
// What the delete window says about where the item goes, by the setting of К4 (docs/sync-plan.md):
// the system trash, or the archive — never the "vault trash" that К1/К5 retire.
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { cleanup, render } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { DeleteConfirmationDialog } from "./delete-confirmation-dialog"
import { DEFAULT_PREFS, type DeleteModePref } from "./app-config"
import { useSettingsStore } from "./use-settings-store"

function ask(mode: DeleteModePref) {
  useSettingsStore.setState({
    prefs: { ...DEFAULT_PREFS, files: { ...DEFAULT_PREFS.files, deleteMode: mode } },
  })
  render(<DeleteConfirmationDialog name="Идеи" onCancel={() => {}} onConfirm={() => {}} />)
  return document.querySelector("[data-slot='dialog-description']")?.textContent ?? ""
}

describe.each([
  ["ru", /системн\p{L}* корзин/iu, /архив/iu, /корзин\p{L}* хранилища/iu],
  ["en", /system trash/i, /archive/i, /vault trash/i],
] as const)("the delete window in %s", (language, system, archive, retired) => {
  beforeEach(async () => {
    await i18n.changeLanguage(language)
  })
  afterEach(cleanup)

  it("says the system trash when the setting is the system trash", () => {
    expect(ask("system")).toMatch(system)
  })

  it("says the archive when the setting is «Переносить в архив» (К4)", () => {
    const line = ask("archive")
    expect(line).toMatch(archive)
    expect(line).not.toMatch(retired)
  })
})
