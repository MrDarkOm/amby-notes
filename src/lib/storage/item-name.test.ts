import { describe, expect, it } from "vitest"

import { isValidItemName } from "./item-name"

describe("isValidItemName", () => {
  it.each([
    "",
    "   ",
    ".git",
    ".GIT",
    ".amby",
    ".obsidian",
    ".trash",
    ".",
    "..",
    "...",
    "CON",
    "nul.txt",
    "COM1",
    "LPT9.log",
    "a:b",
    "a<b",
    'a"b',
    "a|b",
    "a?b",
    "a*b",
    "a/b",
    "a\\b",
    "a\u0000b",
    "trailing.",
    "bad‮name",
    "n".repeat(201),
  ])("refuses %j", (name) => {
    expect(isValidItemName(name)).toBe(false)
  })

  it.each(["Note", "Заметка 2", "a.b", "con1", "COM10", "x-y_z", " padded "])(
    "accepts %j",
    (name) => {
      expect(isValidItemName(name)).toBe(true)
    },
  )
})
