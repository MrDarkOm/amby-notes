import { describe, expect, it } from "vitest"

import {
  dropOptionColor,
  optionColor,
  optionsText,
  parseOptionColors,
  parseOptions,
  renameOptionColor,
  serializeOptions,
  validateOptions,
} from "./property-options"

// docs/sync-plan.md, З62: `settings` is a string; the new form is JSON (the options may hold
// commas), the old one is a comma list and is read as before.
describe("the options of a select", () => {
  it("reads the new form and the old comma form", () => {
    expect(parseOptions('{"options":["А, Б","В"],"default":"В"}')).toEqual({
      options: ["А, Б", "В"],
      default: "В",
    })
    expect(parseOptions("Идея, В работе ,Готово")).toEqual({
      options: ["Идея", "В работе", "Готово"],
      default: null,
    })
    expect(parseOptions("")).toEqual({ options: [], default: null })
    expect(parseOptions("{not json")).toEqual({ options: ["{not json"], default: null })
  })

  it("a default that is not among the options is dropped", () => {
    expect(parseOptions('{"options":["А"],"default":"Б"}').default).toBeNull()
  })

  it("writes the new form without empty options and keeps the default only while it exists", () => {
    expect(serializeOptions(["А", " ", "Б"], "Б")).toBe('{"options":["А","Б"],"default":"Б"}')
    expect(serializeOptions(["А"], "Б")).toBe('{"options":["А"]}')
    expect(serializeOptions([], null)).toBe("")
  })

  it("needs one non-empty option", () => {
    expect(validateOptions(["", "  "])).toBe(false)
    expect(validateOptions(["", "А"])).toBe(true)
  })

  it("shows the options as one line for a quick edit", () => {
    expect(optionsText('{"options":["А","Б"]}')).toBe("А, Б")
  })
})

// docs/sync-plan.md, З63: the colour of an option is a name from the palette of the theme, kept in
// `settings` as "colors"; until chosen it follows from the text of the option.
describe("the colours of the options", () => {
  const names = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"]

  it("reads only the colours written as strings and keeps the options as they were", () => {
    const settings = '{"options":["А","Б"],"colors":{"А":"red","Б":7}}'
    expect(parseOptionColors(settings)).toEqual({ А: "red" })
    expect(parseOptions(settings)).toEqual({ options: ["А", "Б"], default: null })
    expect(parseOptionColors("А,Б")).toEqual({})
    expect(parseOptionColors("")).toEqual({})
  })

  it("writes the colours of the existing options only, and none when there are none", () => {
    expect(serializeOptions(["А", "Б"], null, { А: "red", Нет: "blue" })).toBe(
      '{"options":["А","Б"],"colors":{"А":"red"}}',
    )
    expect(serializeOptions(["А"], "А", {})).toBe('{"options":["А"],"default":"А"}')
  })

  it("keeps a name of a colour it does not know until the options are edited", () => {
    const settings = '{"options":["А"],"colors":{"А":"turquoise"}}'
    const colors = parseOptionColors(settings)
    expect(serializeOptions(["А"], null, colors)).toBe(settings)
    expect(optionColor("А", colors)).not.toBe("turquoise")
    expect(names).toContain(optionColor("А", colors))
  })

  it("takes the chosen colour, else one that follows from the text and never changes", () => {
    expect(optionColor("А", { А: "pink" })).toBe("pink")
    const first = optionColor("Фантастика", {})
    expect(names).toContain(first)
    expect(optionColor("Фантастика", {})).toBe(first)
    expect(
      new Set(["А", "Б", "В", "Г", "Д", "Е", "Ж", "З"].map((o) => optionColor(o, {}))).size,
    ).toBeGreaterThan(2)
  })

  it("moves the colour with a renamed option and drops it with a removed one", () => {
    expect(renameOptionColor({ А: "red", Б: "blue" }, "А", "В")).toEqual({ В: "red", Б: "blue" })
    expect(renameOptionColor({ Б: "blue" }, "А", "В")).toEqual({ Б: "blue" })
    expect(dropOptionColor({ А: "red", Б: "blue" }, "А")).toEqual({ Б: "blue" })
  })
})
