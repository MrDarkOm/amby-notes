import { describe, expect, it } from "vitest"
import registry from "./filter-operators.json"
import {
  defaultOperator,
  filterKind,
  isCompleteCondition,
  isSortable,
  isValidOperand,
  newCondition,
  operandInput,
  operatorsFor,
  withOperator,
} from "./filter-editor-model"

const types = {
  n: "number",
  d: "date",
  c: "checkbox",
  s: "status",
  m: "multiSelect",
  r: "relation",
  f: "files",
  t: "text",
}

describe("filter editor model", () => {
  it("offers exactly the registry's operators per kind, and a text subset for the title", () => {
    for (const [kind, operators] of Object.entries(registry)) {
      if (kind === "relation") continue
      expect(operatorsFor(kind)).toEqual(operators)
    }
    // Relations are only tested for being empty until a page picker is offered.
    expect(operatorsFor("relation")).toEqual(["isEmpty", "isNotEmpty"])
    expect(operatorsFor("title")).toEqual([
      "contains",
      "equals",
      "notEquals",
      "startsWith",
      "isEmpty",
      "isNotEmpty",
    ])
    expect(operatorsFor("unknown")).toEqual([])
  })

  it("starts every kind on an operator the registry allows", () => {
    for (const kind of ["title", ...Object.keys(registry).filter((k) => k !== "system")]) {
      expect(operatorsFor(kind)).toContain(defaultOperator(kind))
    }
  })

  it("chooses the operand editor from kind and operator", () => {
    expect(operandInput("number", "greaterThan")).toBe("number")
    expect(operandInput("number", "isEmpty")).toBe("none")
    expect(operandInput("date", "lessOrEqual")).toBe("date")
    expect(operandInput("status", "equals")).toBe("option")
    expect(operandInput("checkbox", "equals")).toBe("boolean")
    expect(operandInput("relation", "isNotEmpty")).toBe("none")
    expect(operandInput("title", "contains")).toBe("text")
  })

  it("validates operands the way the backend needs them", () => {
    expect(isValidOperand("number", "12.5")).toBe(true)
    expect(isValidOperand("number", "1e5")).toBe(false)
    expect(isValidOperand("number", ">5")).toBe(false)
    expect(isValidOperand("date", "2026-10-02")).toBe(true)
    expect(isValidOperand("date", "02.10.2026")).toBe(false)
    expect(isValidOperand("text", "  ")).toBe(false)
    expect(isValidOperand("boolean", false)).toBe(true)
    expect(isValidOperand("option", "")).toBe(false)
  })

  it("treats a half-filled row as a draft", () => {
    const draft = newCondition("n", types)
    expect(isCompleteCondition(draft, types)).toBe(false)
    expect(isCompleteCondition({ ...draft, operand: "7" }, types)).toBe(true)
    expect(isCompleteCondition(newCondition("r", types), types)).toBe(true)
    expect(isCompleteCondition(newCondition("c", types), types)).toBe(true)
    expect(
      isCompleteCondition(
        { ...newCondition("n", types), operator: "contains", operand: "7" },
        types,
      ),
    ).toBe(false)
  })

  it("keeps the operand when switching between operators of the same editor, else resets it", () => {
    const base = { ...newCondition("n", types), operand: "7" }
    expect(withOperator(base, "greaterOrEqual", types).operand).toBe("7")
    expect(withOperator(base, "isEmpty", types).operand).toBeUndefined()
    expect(withOperator(newCondition("d", types), "isNotEmpty", types).operand).toBeUndefined()
  })

  it("knows which columns can be sorted", () => {
    expect(isSortable("title", types)).toBe(true)
    expect(isSortable("n", types)).toBe(true)
    expect(isSortable("r", types)).toBe(false)
    expect(isSortable("m", types)).toBe(false)
    expect(filterKind("title", types)).toBe("title")
    expect(filterKind("zz", types)).toBeNull()
  })
})
