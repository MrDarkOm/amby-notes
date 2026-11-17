import { describe, expect, it } from "vitest"
import { localeResources } from "./resources"

const leaves = (value: Record<string, unknown>, prefix = ""): Record<string, string> =>
  Object.entries(value).reduce<Record<string, string>>((all, [name, child]) => {
    if (typeof child === "object" && child !== null)
      return { ...all, ...leaves(child as Record<string, unknown>, `${prefix}${name}.`) }
    return { ...all, [`${prefix}${name}`]: String(child) }
  }, {})

/** Plural forms each language uses (CLDR); keys with other forms are dead weight. */
const pluralForms: Record<string, readonly string[]> = {
  ru: ["one", "few", "many", "other"],
  en: ["one", "other"],
}
/** Forms every plural key must have: Russian integers never use "other". */
const requiredForms: Record<string, readonly string[]> = {
  ru: ["one", "few", "many"],
  en: ["one", "other"],
}

const pluralSuffix = /_(zero|one|two|few|many|other)$/u
const placeholders = (text: string) =>
  [...text.matchAll(/\{\{\s*([\w.]+)\s*(?:,[^}]*)?\}\}/gu)].map((m) => m[1]).sort()
/** A key is plural only if a sibling has the "one" or "other" form (`importReason.too_many` is not). */
const isPluralKey = (key: string, entries: Record<string, string>) =>
  pluralSuffix.test(key) &&
  (`${key.replace(pluralSuffix, "")}_one` in entries ||
    `${key.replace(pluralSuffix, "")}_other` in entries)
const baseKey = (key: string) => key.replace(pluralSuffix, "")
const bases = (keys: string[]) => [...new Set(keys.map(baseKey))].sort()

describe("localization resources structure", () => {
  const dictionaries = Object.fromEntries(
    Object.entries(localeResources).map(([code, { translation }]) => [code, leaves(translation)]),
  )

  it("use only the plural forms the language has", () => {
    for (const [code, entries] of Object.entries(dictionaries)) {
      const allowed = pluralForms[code]
      const wrong = Object.keys(entries).filter((key) => {
        const form = pluralSuffix.exec(key)?.[1]
        return (
          isPluralKey(key, entries) &&
          form !== undefined &&
          allowed !== undefined &&
          !allowed.includes(form)
        )
      })
      expect(wrong, `${code}: plural forms the language does not use`).toEqual([])
    }
  })

  it("have the same set of keys in every language (plural forms aside)", () => {
    const reference = bases(Object.keys(dictionaries.ru))
    for (const [code, entries] of Object.entries(dictionaries)) {
      expect(bases(Object.keys(entries)), `${code} keys`).toEqual(reference)
    }
  })

  it("give every plural key all the forms its language needs", () => {
    for (const [code, entries] of Object.entries(dictionaries)) {
      const forms = requiredForms[code] ?? []
      const keys = Object.keys(entries)
      for (const base of new Set(keys.filter((k) => isPluralKey(k, entries)).map(baseKey))) {
        // i18next falls back to the bare key when "_other" is absent.
        const missing = forms.filter(
          (form) => !(`${base}_${form}` in entries) && !(form === "other" && base in entries),
        )
        expect(missing, `${code}: ${base} lacks forms`).toEqual([])
      }
    }
  })

  it("keep the same {{placeholders}} in every translation of a key", () => {
    const ru = dictionaries.ru
    const other = dictionaries.en
    const differing: string[] = []
    for (const [key, text] of Object.entries(ru)) {
      const counterpart = other[key] ?? other[`${baseKey(key)}_other`]
      if (counterpart === undefined) continue
      const a = placeholders(text)
      const b = placeholders(counterpart)
      // Plural forms may drop {{count}} ("one" is often written as "1 file"); compare the rest.
      const strip = (list: string[]) =>
        isPluralKey(key, ru) ? list.filter((n) => n !== "count") : list
      if (JSON.stringify(strip(a)) !== JSON.stringify(strip(b)))
        differing.push(`${key}: ${a} vs ${b}`)
    }
    expect(differing).toEqual([])
  })
})
