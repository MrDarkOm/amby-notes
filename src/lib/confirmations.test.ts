// @vitest-environment happy-dom
// Every question the application asks before a hard-to-undo action (docs/notices.md, sections 9 and 10):
// a title that is a question with the name of the object, one line about the data, a verb on the button,
// and a look that is dangerous only when it is. The same checks in every language.
import { beforeEach, describe, expect, it } from "vitest"
import i18n from "@/lib/i18n"
import { confirmations } from "./confirmations"
import type { ConfirmOptions } from "./confirm"

interface Case {
  /** The questions that name an object say it in the title. */
  names?: string[]
  /** Dangerous: red button, the focus on Cancel. */
  destructive: boolean
  ask: () => ConfirmOptions
}

const cases: Record<string, Case> = {
  restoreVersion: { destructive: false, ask: () => confirmations.restoreVersion() },
  deleteVersion: { destructive: true, ask: () => confirmations.deleteVersion() },
  cleanHistory: {
    destructive: true,
    names: ["32"],
    ask: () => confirmations.cleanHistory({ count: 32, size: "6 КБ" }),
  },
  clearHistory: {
    destructive: true,
    names: ["52"],
    ask: () => confirmations.clearHistory({ count: 52, size: "10 КБ" }),
  },
  deleteArchived: {
    destructive: true,
    names: ["Черновик"],
    ask: () => confirmations.deleteArchived({ name: "Черновик" }),
  },
  removeTheme: {
    destructive: false,
    names: ["Закат"],
    ask: () => confirmations.removeTheme({ name: "Закат" }),
  },
  resetSettings: { destructive: true, ask: () => confirmations.resetSettings() },
  deleteDebugHistory: { destructive: true, ask: () => confirmations.deleteDebugHistory() },
  deleteLayer: {
    destructive: true,
    names: ["План"],
    ask: () => confirmations.deleteLayer({ layer: "холст", title: "План" }),
  },
  removeAiConnection: {
    destructive: true,
    names: ["Домашний"],
    ask: () => confirmations.removeAiConnection({ name: "Домашний" }),
  },
  deleteNotebook: {
    destructive: false,
    names: ["Архив"],
    ask: () => confirmations.deleteNotebook({ name: "Архив", count: 3, where: "«Мир»" }),
  },
  renameRefactor: {
    destructive: false,
    names: ["2", "5"],
    ask: () => confirmations.renameRefactor({ replacements: 5, notes: 2 }),
  },
  moveRefactor: {
    destructive: false,
    names: ["2", "5"],
    ask: () => confirmations.moveRefactor({ replacements: 5, notes: 2 }),
  },
  mergeNotes: {
    destructive: false,
    names: ["Черновик", "Итог"],
    ask: () => confirmations.mergeNotes({ source: "Черновик", target: "Итог" }),
  },
  deletePermanent: {
    destructive: true,
    names: ["План"],
    ask: () => confirmations.deletePermanent({ count: 1, name: "План" }),
  },
  deletePermanentMany: {
    destructive: true,
    names: ["4"],
    ask: () => confirmations.deletePermanent({ count: 4, name: "План" }),
  },
  switchAfterSaveFailure: { destructive: true, ask: () => confirmations.switchAfterSaveFailure() },
  resumeMigration: {
    destructive: false,
    names: ["7"],
    ask: () => confirmations.resumeMigration({ files: 7 }),
  },
  rollbackMigration: { destructive: true, ask: () => confirmations.rollbackMigration() },
  restoreDraft: { destructive: false, ask: () => confirmations.restoreDraft() },
  overwriteExternal: { destructive: true, ask: () => confirmations.overwriteExternal() },
  deleteDatabaseView: {
    destructive: true,
    names: ["Таблица"],
    ask: () => confirmations.deleteDatabaseView({ name: "Таблица" }),
  },
}

const EMPTY_VERBS = new Set(["ок", "ok", "да", "yes", "подтвердить", "confirm", "продолжить?"])

describe.each(["ru", "en"])("questions in %s", (language) => {
  beforeEach(async () => {
    await i18n.changeLanguage(language)
  })

  it.each(Object.entries(cases))("%s is a proper question", (_name, item) => {
    const question = item.ask()
    expect(question.title.trim().endsWith("?")).toBe(true)
    for (const name of item.names ?? [])
      expect(question.title + question.description).toContain(name)
    // One line about what happens to the data.
    expect(question.description?.trim()).toBeTruthy()
    expect(question.description).not.toContain("\n")
    // The verb is a verb of the action, short, never "OK"; Cancel is the application's own word.
    expect(question.confirmLabel.trim().split(/\s+/u).length).toBeLessThanOrEqual(3)
    expect(EMPTY_VERBS.has(question.confirmLabel.trim().toLowerCase())).toBe(false)
    expect(Boolean(question.destructive)).toBe(item.destructive)
    // Every word came from the locale: nothing is left unfilled.
    for (const text of [question.title, question.description ?? "", question.confirmLabel]) {
      expect(text).not.toMatch(/\{\{|confirmations\./u)
    }
  })

  it("does not show a file extension or a path in a title", () => {
    for (const item of Object.values(cases)) {
      expect(item.ask().title).not.toMatch(/\.(md|canvas|excalidraw)\b|\/|\\/u)
    }
  })
})

describe("the dangerous questions say what Cancel keeps where it is not obvious", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
  })

  it("overwriting a file changed elsewhere: Cancel keeps the other version and the text stays in a draft", () => {
    const { description } = confirmations.overwriteExternal()
    expect(description).toMatch(/черновик/iu)
  })

  it("switching a vault after a failed save: the drafts are kept", () => {
    expect(confirmations.switchAfterSaveFailure().description).toMatch(/черновик/iu)
  })
})
