// @vitest-environment happy-dom
import { chooseOption } from "@/lib/test-utils/amby-select"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import type { DatabasePropertySummary } from "@/lib/storage"
import { ViewFilterEditor } from "./view-filter-editor"
import type { ViewCondition } from "./view-config"

const properties: DatabasePropertySummary[] = [
  { propertyId: "n", name: "Budget", propertyType: "number", configJson: "{}", options: [] },
  {
    propertyId: "s",
    name: "Status",
    propertyType: "status",
    configJson: "{}",
    options: [{ optionId: "o1", name: "In progress", color: "#3b82f6" }],
  },
]
const budget = (operator: string, operand?: unknown): ViewCondition => ({
  field: { kind: "property", propertyId: "n" },
  operator,
  operand,
})

describe("ViewFilterEditor", () => {
  afterEach(cleanup)

  function setup(conditions: ViewCondition[], onChange = vi.fn()) {
    render(
      <ViewFilterEditor
        conditions={conditions}
        complex={false}
        properties={properties}
        titleName="Name"
        onChange={onChange}
        onResetComplex={() => {}}
      />,
    )
    return onChange
  }

  it("shows one row per saved condition, and an unfinished saved one only once", () => {
    setup([budget("greaterOrEqual", "5"), budget("lessThan", undefined)])
    expect(screen.getAllByLabelText("Условие")).toHaveLength(2)
  })

  it("keeps a half-filled row out of the saved filter and sends it once complete", () => {
    const onChange = setup([])
    fireEvent.click(screen.getByText("Добавить фильтр"))
    // Name column, "contains", no value yet: a draft.
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText("Значение"), { target: { value: "acme" } })
    expect(onChange).toHaveBeenCalledWith([
      { field: { kind: "system", field: "title" }, operator: "contains", operand: "acme" },
    ])
  })

  it("offers only operators valid for the column and only valid numbers", async () => {
    const onChange = setup([budget("equals", "1")])
    fireEvent.click(screen.getByRole("combobox", { name: "Условие" }))
    const operators = (await screen.findAllByRole("option")).map((option) => option.textContent)
    // A number column has no text operators such as "contains".
    expect(operators).toHaveLength(8)
    expect(operators.some((label) => /содерж/i.test(label ?? ""))).toBe(false)
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" })
    act(() => {
      fireEvent.change(screen.getByLabelText("Значение"), { target: { value: ">100" } })
    })
    // ">100" is not a number: nothing is saved, the row becomes a draft.
    expect(onChange).toHaveBeenLastCalledWith([])
  })

  it("lets a Status filter pick an option by name and saves its ID", async () => {
    const onChange = setup([])
    fireEvent.click(screen.getByText("Добавить фильтр"))
    await chooseOption("Свойство", "Status")
    await chooseOption("Значение", "In progress")
    expect(onChange).toHaveBeenLastCalledWith([
      { field: { kind: "property", propertyId: "s" }, operator: "equals", operand: "o1" },
    ])
  })

  it("shows a complex saved filter as reset-only", () => {
    const reset = vi.fn()
    render(
      <ViewFilterEditor
        conditions={[]}
        complex
        properties={properties}
        titleName="Name"
        onChange={() => {}}
        onResetComplex={reset}
      />,
    )
    fireEvent.click(screen.getByText("Сбросить сложный фильтр"))
    expect(reset).toHaveBeenCalled()
  })
})
