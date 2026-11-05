// @vitest-environment happy-dom
// One mapping «type of a property → Lucide icon» for the panel of a note and for databases
// (docs/sync-plan.md, З61); a property without an icon of its own shows the icon of its type.
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import "@/lib/i18n"
import { parseIconValue } from "./icon-values"
import { propertyTypeIcon, propertyTypeIconName } from "./property-type-icons"
import { FrontmatterPropertyRow } from "./panels/info-frontmatter-rows"
import { PropertyTypeIcon } from "./database/property-type-icon"

afterEach(cleanup)

describe("the icon of a type", () => {
  it("is the set of the plan", () => {
    expect(
      ["text", "number", "checkbox", "date", "url", "select", "list"].map(propertyTypeIconName),
    ).toEqual([
      "align-justify",
      "hash",
      "square-check",
      "calendar-days",
      "link-2",
      "circle-chevron-down",
      "list",
    ])
    expect(propertyTypeIcon("something unknown")).toBe(propertyTypeIcon("text"))
  })

  it("an icon value with no colour is read and keeps the colour of the text", () => {
    const parsed = parseIconValue("amby-icon:flag:")
    expect(parsed?.name).toBe("flag")
    expect(parsed?.color).toBe("")
  })

  it("the database and the note panel draw the same icon for a type", () => {
    const database = render(<PropertyTypeIcon type="select" />)
    expect(database.container.querySelector(".lucide-circle-chevron-down")).not.toBeNull()
    cleanup()
    const note = render(
      <FrontmatterPropertyRow
        property={{ key: "Выбор", value: "x", valueKind: "text" }}
        propertyType="select"
        settings="А,Б"
      />,
    )
    expect(note.container.querySelector(".lucide-circle-chevron-down")).not.toBeNull()
  })

  it("a property without an icon of its own shows the icon of its type: a flag for a checkbox", () => {
    const { container } = render(
      <FrontmatterPropertyRow
        property={{ key: "Готово", value: "true", valueKind: "checkbox" }}
        propertyType="checkbox"
        settings=""
      />,
    )
    expect(container.querySelector(".lucide-square-check-big")).not.toBeNull()
  })
})
