// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render } from "@testing-library/react"
import "@/lib/i18n"
import type { ChatStep } from "@/lib/storage"
import { StepLine } from "./message-view"

afterEach(cleanup)

const line = (step: ChatStep) => {
  const { container } = render(<StepLine step={step} items={[]} onSelect={() => {}} />)
  const text = container.querySelector("summary span")?.textContent
  cleanup()
  return text
}

describe("AI step lines", () => {
  it("names the read tools in words, with the note title rather than its path", () => {
    expect(
      line({
        tool: "get_properties",
        query: "Projects/Garden/Garden plan.md",
        noteIds: [],
        error: null,
      }),
    ).toBe("Посмотрел свойства «Garden plan»")
  })

  it("names a database step by the row or database the reply named", () => {
    expect(
      line({ tool: "create_database_row", query: "Shop/Buy/Milk.md", noteIds: [], error: null }),
    ).toBe("Подготовил изменение «Milk»")
    expect(line({ tool: "read_database", query: "Buy", noteIds: [], error: null })).toBe(
      "Прочитал базу «Buy»",
    )
  })

  it("says a change was prepared for the tools that propose one", () => {
    expect(line({ tool: "append_note", query: "Shopping.md", noteIds: [], error: null })).toBe(
      "Подготовил изменение «Shopping»",
    )
  })

  it("says which note was not found instead of a general failure", () => {
    expect(
      line({ tool: "read_note", query: "Garden plan.md", noteIds: [], error: "notFound" }),
    ).toBe("Не нашёл «Garden plan»")
    expect(line({ tool: "read_note", query: "Plan", noteIds: [], error: "ambiguous" })).toBe(
      "Несколько заметок называются «Plan»",
    )
    expect(line({ tool: "read_note", query: "x", noteIds: [], error: "somethingElse" })).toBe(
      "Не удалось выполнить шаг",
    )
  })
})
