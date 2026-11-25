import { describe, expect, it } from "vitest"
import type { SearchResult } from "@/lib/storage"
import { collectMentions, mentionNames, mentionsName, searchQueries } from "./mention-model"

function result(id: string, snippet: string | null, title = id): SearchResult {
  return {
    note: { id, path: `/vault/${id}.md`, title, wordCount: 0 },
    matchType: "content",
    snippet: snippet ?? undefined,
    score: 0,
  }
}

describe("mentionNames", () => {
  it("searches the full title and each word of a title of several words", () => {
    expect(mentionNames("Evan Key", "")).toEqual(["Evan Key", "Evan", "Key"])
  })

  it("leaves out words too short to tell apart and keeps a one-word title as is", () => {
    expect(mentionNames("Jo de Witt", "")).toEqual(["Jo de Witt", "Witt"])
    expect(mentionNames("Алиса", "")).toEqual(["Алиса"])
    expect(mentionNames("  ", "")).toEqual([])
  })

  it("adds the aliases of the frontmatter in each common form, once", () => {
    const list = "---\naliases:\n  - Кей\n  - 'Evan'\nrole: hero\n---\n# Evan Key\n"
    expect(mentionNames("Evan Key", list)).toEqual(["Evan Key", "Evan", "Key", "Кей"])
    const inline = '---\naliases: [Кей, "Малыш"]\n---\n'
    expect(mentionNames("Evan Key", inline)).toEqual(["Evan Key", "Evan", "Key", "Кей", "Малыш"])
    const single = "﻿---\r\nalias: Кей\r\n---\r\n"
    expect(mentionNames("Evan Key", single)).toEqual(["Evan Key", "Evan", "Key", "Кей"])
  })

  it("does not read aliases outside the frontmatter", () => {
    expect(mentionNames("Evan", "# Evan\n\naliases: [Кей]\n")).toEqual(["Evan"])
  })
})

describe("searchQueries", () => {
  it("also asks for the stem of a declinable name when the stem is long enough", () => {
    expect(searchQueries(["Алиса", "Кей", "Evan"])).toEqual([
      { name: "Алиса", query: "Алиса" },
      { name: "Алиса", query: "Алис" },
      { name: "Кей", query: "Кей" },
      { name: "Evan", query: "Evan" },
    ])
  })
})

describe("mentionsName", () => {
  it("finds the name as a word, in any case, with a short ending", () => {
    expect(mentionsName("Потом Кей ушёл.", "Кей")).toBe(true)
    expect(mentionsName("Она ждала Кея у двери.", "Кей")).toBe(true)
    expect(mentionsName("evan's car", "Evan")).toBe(true)
    expect(mentionsName("— Evan   Key, — сказал он.", "Evan Key")).toBe(true)
  })

  it("does not take a longer word or a part of a word for the name", () => {
    expect(mentionsName("Кейтлин пришла.", "Кей")).toBe(false)
    expect(mentionsName("Bakey", "Key")).toBe(false)
    expect(mentionsName("Evan Keyboard", "Evan Key")).toBe(false)
  })

  it("treats the name as text, not as a pattern", () => {
    expect(mentionsName("a.b", "a+b")).toBe(false)
    expect(mentionsName("x (a+b) y", "a+b")).toBe(true)
  })
})

describe("collectMentions", () => {
  const textPages = new Map([
    ["p1", { title: "Глава 1", storyName: "MoleHills" }],
    ["p2", { title: "Глава 2", storyName: "MoleHills" }],
    ["p3", { title: "Пролог", storyName: "Other" }],
  ])

  it("keeps pages of the text whose snippet really names the character, once each", () => {
    const mentions = collectMentions({
      searches: [
        { name: "Evan Key", results: [result("p1", "и тогда Evan Key сказал")] },
        {
          name: "Кей",
          results: [
            result("p1", "Кей ушёл"),
            result("p2", "Кейтлин ушла"),
            result("p3", "ждала Кея"),
            result("note", "Кей в заметке"),
          ],
        },
      ],
      textPages,
      exclude: new Set(),
    })
    expect(mentions).toEqual([
      {
        noteId: "p1",
        title: "Глава 1",
        storyName: "MoleHills",
        snippet: "и тогда Evan Key сказал",
      },
      { noteId: "p3", title: "Пролог", storyName: "Other", snippet: "ждала Кея" },
    ])
  })

  it("leaves out the pages already linked and results without a snippet", () => {
    const mentions = collectMentions({
      searches: [{ name: "Кей", results: [result("p1", "Кей"), result("p2", null)] }],
      textPages,
      exclude: new Set(["p1"]),
    })
    expect(mentions).toEqual([])
  })
})
