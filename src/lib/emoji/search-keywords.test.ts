// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { init, SearchIndex } from "emoji-mart"
import type { EmojiMartData } from "@emoji-mart/data"
import type { EmojiSearchLocale } from "@/locales/emoji-search"
import { withEmojiSearchKeywords } from "./search-keywords"
import { configurePickerSearch } from "./picker-search"
import ru from "@/locales/emoji-search/ru.json"

const data = (): EmojiMartData => ({
  categories: [{ id: "nature", emojis: ["cat", "thumb", "sun", "woman"] }],
  aliases: { kitty: "cat" },
  sheet: { cols: 1, rows: 1 },
  emojis: {
    cat: {
      id: "cat",
      name: "Cat face",
      keywords: ["animal"],
      skins: [{ unified: "1F431", native: "🐱" }],
      version: 1,
    },
    thumb: {
      id: "thumb",
      name: "Thumbs up",
      keywords: ["yes"],
      skins: [
        { unified: "1f44d", native: "👍" },
        { unified: "1f44d-1f3fd", native: "👍🏽" },
      ],
      version: 1,
    },
    sun: {
      id: "sun",
      name: "Sun",
      keywords: ["weather"],
      skins: [{ unified: "2600", native: "☀" }],
      version: 1,
    },
    woman: {
      id: "woman",
      name: "Woman",
      keywords: [],
      skins: [{ unified: "1f469", native: "👩" }],
      version: 1,
    },
  },
})
const pack = (locale: string, keywords: EmojiSearchLocale["keywords"]): EmojiSearchLocale => ({
  locale,
  keywords,
  source: "Test fixture",
  revision: "1",
  license: "Test fixture",
})
const locales = [
  pack("ru", {
    "🐱": [" КОТ ", "домашний кот", "кот"],
    "👍🏽": ["одобрение"],
    "☀️": ["солнце", "arc-en-ciel"],
    "👩‍💻": ["программистка"],
  }),
  pack("ja", { "🐱": ["ねこ"] }),
]

describe("bundled emoji search vocabulary", () => {
  it("keeps the default data allocation-free until language packs are registered", () => {
    const original = data()
    expect(withEmojiSearchKeywords(original, "en", [])).toBe(original)
  })
  it("selects the current language, merges English and qualification aliases without changing source data or skin choices", () => {
    const original = data()
    const before = JSON.stringify(original)
    const result = withEmojiSearchKeywords(original, "ru-RU", locales)
    expect(result.emojis.cat.keywords).toEqual([
      "animal",
      "кот",
      "домашний",
      "домашний".normalize("NFD"),
    ])
    expect(result.emojis.cat.keywords).not.toContain("ねこ")
    expect(withEmojiSearchKeywords(original, "ja", locales).emojis.cat.keywords).toContain("ねこ")
    expect(withEmojiSearchKeywords(original, "en", locales)).toBe(original)
    expect(withEmojiSearchKeywords(original, "zz", locales)).toBe(original)
    expect(result.emojis.sun.keywords).toContain("солнце")
    expect(result.emojis.thumb.keywords).toContain("одобрение")
    expect(result.emojis.woman.keywords).not.toContain("программистка")
    expect(result.emojis.thumb.skins).toEqual(original.emojis.thumb.skins)
    expect(result.aliases).toEqual(original.aliases)
    expect(result.categories).toEqual(original.categories)
    expect(JSON.stringify(original)).toBe(before)
  })
  it("invalidates cached Mart search strings only on changed entries", () => {
    const original = data()
    Object.assign(original.emojis.cat, { search: ",cat,animal" })
    expect(withEmojiSearchKeywords(original, "ru-RU", locales).emojis.cat).not.toHaveProperty(
      "search",
    )
    expect(original.emojis.cat).toHaveProperty("search", ",cat,animal")
  })
  it("switches the installed Mart index RU → EN → JA → RU without leaking vocabulary", async () => {
    const catalog = data()
    const initialize = () => init({ data: catalog, set: "google", i18n: {} })
    configurePickerSearch(catalog, "ru", locales)
    await initialize()
    for (const query of [
      "КОТ",
      "ко",
      "домашний кот",
      "домашний кот".normalize("NFD"),
      "cat",
      "animal",
    ]) {
      expect(
        (await SearchIndex.search(query))?.map((emoji: { id: string }) => emoji.id),
        query,
      ).toContain("cat")
    }
    for (const query of ["arc-en-ciel", "arc en ciel"]) {
      expect(
        (await SearchIndex.search(query))?.map((emoji: { id: string }) => emoji.id),
        query,
      ).toContain("sun")
    }
    expect(
      (await SearchIndex.search("одобрение"))?.map((emoji: { id: string }) => emoji.id),
    ).toContain("thumb")
    configurePickerSearch(catalog, "en", locales)
    await initialize()
    expect(await SearchIndex.search("кот")).toEqual([])
    expect((await SearchIndex.search("cat"))?.map((emoji: { id: string }) => emoji.id)).toContain(
      "cat",
    )
    configurePickerSearch(catalog, "ja", locales)
    await initialize()
    expect(await SearchIndex.search("кот")).toEqual([])
    expect((await SearchIndex.search("ねこ"))?.map((emoji: { id: string }) => emoji.id)).toContain(
      "cat",
    )
    configurePickerSearch(catalog, "ru", locales)
    await initialize()
    expect(await SearchIndex.search("ねこ")).toEqual([])
    expect((await SearchIndex.search("кот"))?.map((emoji: { id: string }) => emoji.id)).toContain(
      "cat",
    )
  })

  it("ships the pinned Russian CLDR vocabulary and its provenance", () => {
    expect(Object.keys(ru.keywords).length).toBe(3963)
    expect(ru.keywords["🐱"]).toContain("кот")
    expect(ru.keywords["🇫🇮"]).toContain("флаг: Финляндия")
    expect(ru.license).toBe("Unicode-3.0")
    expect(ru.inputs).toHaveLength(3)
    for (const input of ru.inputs) expect(input.url).toContain(ru.revision)
  })
})
