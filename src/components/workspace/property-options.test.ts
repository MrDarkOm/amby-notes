import { describe, expect, it } from "vitest"

import { optionsText, parseOptions, serializeOptions, validateOptions } from "./property-options"

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
