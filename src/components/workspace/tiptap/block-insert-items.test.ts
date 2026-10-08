import { describe, expect, it } from "vitest"

import { localeResources } from "@/locales/resources"
import { filterBlockItems, getSlashItems } from "./block-insert-items"

const strings = localeResources.ru.translation.blockItems as Record<
  string,
  { title: string; hint: string }
>
const filter = (query: string) =>
  filterBlockItems(
    getSlashItems(),
    query,
    (item) => strings[item.id].title,
    (item) => strings[item.id].hint,
  )

describe("the slash menu list", () => {
  it("shows every block, group after group, when nothing is typed", () => {
    const all = filter("")
    expect(all).toHaveLength(getSlashItems().length)
    const groups = all.map((item) => item.category)
    const order = groups.filter((group, index) => group !== groups[index - 1])
    expect(order).toEqual(["text", "list", "media", "embed"])
  })

  it("narrows as the name is typed, in either case", () => {
    expect(filter("заг").map((item) => item.id)).toEqual(["h1", "h2", "h3", "h4", "h5", "h6"])
    expect(filter("ЗАГОЛОВОК 2").map((item) => item.id)).toEqual(["h2"])
    // "Список задач" starts with the query; the other two only contain the word.
    expect(filter("спис").map((item) => item.id)).toEqual(["task", "bullet", "ordered"])
  })

  it("puts a name that starts with the query before one that only contains it", () => {
    const ids = filter("код").map((item) => item.id)
    expect(ids[0]).toBe("code")
  })

  it("finds a block by its Markdown form and by its id", () => {
    expect(filter("```").map((item) => item.id)).toContain("code")
    expect(filter("h3").map((item) => item.id)).toEqual(["h3"])
  })

  it("has a title and a hint for every item in both languages", () => {
    for (const language of ["ru", "en"] as const) {
      const table = localeResources[language].translation.blockItems as Record<
        string,
        { title: string; hint: string }
      >
      for (const item of getSlashItems()) {
        expect(table[item.id]?.title, `${language} ${item.id}`).toBeTruthy()
        expect(table[item.id]?.hint, `${language} ${item.id}`).toBeTruthy()
      }
    }
  })

  it("leaves nothing for text that names no block", () => {
    expect(filter("qwertyzz")).toEqual([])
  })
})
