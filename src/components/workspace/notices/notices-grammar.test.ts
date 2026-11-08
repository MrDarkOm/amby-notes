// The texts of the notices name a note: where the name stands before a verb that agrees in gender or number,
// the word "note" goes with it (“Заметка «Дневник» не сохранилась”, not “«Дневник» не сохранилась”).
import { beforeAll, describe, expect, it } from "vitest"
import i18n from "@/lib/i18n"
import { localeResources } from "@/locales/resources"

const NAME = "Дневник"

function strings(
  node: unknown,
  prefix: string,
  into: Array<[string, string]> = [],
): Array<[string, string]> {
  if (typeof node === "string") into.push([prefix, node])
  else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node))
      strings(value, prefix ? `${prefix}.${key}` : key, into)
  }
  return into
}

describe("a note named before its verb", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("ru")
  })

  it.each([
    ["notices.centre.closedSaveFailed", "Заметка «Дневник» не сохранилась"],
    ["notices.centre.note.save-failed.title", "Заметка «Дневник» не сохранилась"],
    ["notices.centre.note.remote-deleted.title", "Заметка «Дневник» удалена на другом компьютере"],
    ["notices.centre.note.external-change.title", "Заметка «Дневник» изменена вне Amby"],
    ["notices.centre.note.property-failed.title", "В заметке «Дневник» не сохранилось свойство"],
    ["notices.centre.note.draft.title", "У заметки «Дневник» есть несохранённая версия"],
    ["sync.vault.conflicts.editedTitle", "Заметка «Дневник» изменена на двух компьютерах"],
    ["sync.vault.conflicts.createdTitle", "Заметка «Дневник» создана на двух компьютерах"],
  ])("%s reads “%s”", (key, expected) => {
    expect(i18n.t(key, { name: NAME, lng: "ru" })).toBe(expected)
  })

  it.each([
    ["notices.centre.closedSaveFailed", "The note “Дневник” was not saved"],
    ["notices.centre.note.save-failed.title", "The note “Дневник” was not saved"],
    [
      "notices.centre.note.remote-deleted.title",
      "The note “Дневник” was deleted on another computer",
    ],
    ["notices.centre.note.external-change.title", "The note “Дневник” was changed outside Amby"],
    ["notices.centre.note.property-failed.title", "A property of the note “Дневник” was not saved"],
    ["notices.centre.note.draft.title", "The note “Дневник” has an unsaved version"],
    ["sync.vault.conflicts.editedTitle", "The note “Дневник” was changed on two computers"],
    ["sync.vault.conflicts.createdTitle", "The note “Дневник” was created on two computers"],
  ])("%s reads “%s” in English", (key, expected) => {
    expect(i18n.t(key, { name: NAME, lng: "en" })).toBe(expected)
  })

  it("never starts a sentence of a notice with the bare name followed by a verb, in any language", () => {
    const namespaces = ["notices", "sync.notices", "sync.vault.conflicts", "noteNotices"]
    const offenders: string[] = []
    for (const [language, bundle] of Object.entries(localeResources)) {
      const all = strings(bundle.translation, "")
      for (const [key, text] of all) {
        if (!namespaces.some((space) => key.startsWith(`${space}.`))) continue
        // “«{{name}}» не сохранилась”: the name, then a word that is not a mark of punctuation.
        if (/^[«“"]\{\{name\}\}[»”"]\s+[\p{L}]/u.test(text))
          offenders.push(`${language} ${key}: ${text}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
