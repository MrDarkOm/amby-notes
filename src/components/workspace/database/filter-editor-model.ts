import type { DatabasePropertySummary } from "@/lib/storage"
import registry from "./filter-operators.json"
import { fieldKey, fieldRefFromKey, TITLE_KEY, type ViewCondition } from "./view-config"

/**
 * What the typed filter editor offers. The operator table is
 * `filter-operators.json`, the same file the Rust registry test checks, so the
 * UI cannot offer an operator the backend rejects.
 */

export type OperandInput = "none" | "text" | "number" | "date" | "boolean" | "option"

const OPERATORS = registry as Record<string, string[]>
const TITLE_OPERATORS = new Set([
  "contains",
  "equals",
  "notEquals",
  "startsWith",
  "isEmpty",
  "isNotEmpty",
])
const NO_OPERAND = new Set(["isEmpty", "isNotEmpty"])
const SORTABLE_TYPES = new Set(["text", "url", "number", "date", "checkbox", "select", "status"])

/** The registry kind of a field: the Title behaves like text. */
export function filterKind(key: string, types: Record<string, string>): string | null {
  if (key === TITLE_KEY) return "title"
  return types[key] ?? null
}

export function operatorsFor(kind: string): string[] {
  if (kind === "title") return OPERATORS.system.filter((operator) => TITLE_OPERATORS.has(operator))
  // Matching a particular linked page needs a page picker the editor does not have yet.
  if (kind === "relation") return OPERATORS.relation.filter((operator) => operator !== "contains")
  return OPERATORS[kind] ?? []
}

export function defaultOperator(kind: string): string {
  switch (kind) {
    case "title":
    case "text":
    case "url":
    case "multiSelect":
    case "relation":
      return kind === "relation" ? "isNotEmpty" : "contains"
    case "files":
      return "isNotEmpty"
    default:
      return "equals"
  }
}

export function operandInput(kind: string, operator: string): OperandInput {
  if (NO_OPERAND.has(operator)) return "none"
  switch (kind) {
    case "number":
      return "number"
    case "date":
      return "date"
    case "checkbox":
      return "boolean"
    case "select":
    case "status":
    case "multiSelect":
      return "option"
    case "relation":
    case "files":
      return "none"
    default:
      return "text"
  }
}

const DECIMAL = /^-?\d+(\.\d+)?$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Whether the typed value is something the backend accepts as an operand. */
export function isValidOperand(input: OperandInput, operand: unknown): boolean {
  switch (input) {
    case "none":
      return true
    case "text":
      return typeof operand === "string" && operand.trim().length > 0
    case "number":
      return typeof operand === "string" && DECIMAL.test(operand.trim())
    case "date":
      return typeof operand === "string" && ISO_DATE.test(operand)
    case "boolean":
      return typeof operand === "boolean"
    case "option":
      return typeof operand === "string" && operand.length > 0
  }
}

export function isCompleteCondition(
  condition: ViewCondition,
  types: Record<string, string>,
): boolean {
  const key = fieldKey(condition.field)
  const kind = key ? filterKind(key, types) : null
  if (!key || !kind || !operatorsFor(kind).includes(condition.operator)) return false
  return isValidOperand(operandInput(kind, condition.operator), condition.operand)
}

/** A new row for a column, with the operator a user most likely wants. */
export function newCondition(key: string, types: Record<string, string>): ViewCondition {
  const kind = filterKind(key, types) ?? "text"
  const operator = defaultOperator(kind)
  const input = operandInput(kind, operator)
  return {
    field: fieldRefFromKey(key),
    operator,
    operand: input === "boolean" ? true : undefined,
  }
}

/** The condition after the user picked another operator; the operand is kept when still meaningful. */
export function withOperator(
  condition: ViewCondition,
  operator: string,
  types: Record<string, string>,
): ViewCondition {
  const key = fieldKey(condition.field)
  const kind = (key && filterKind(key, types)) || "text"
  const before = operandInput(kind, condition.operator)
  const after = operandInput(kind, operator)
  return {
    ...condition,
    operator,
    operand: before === after ? condition.operand : after === "boolean" ? true : undefined,
  }
}

export function filterableKeys(
  properties: DatabasePropertySummary[],
): Array<{ key: string; name: string; type: string }> {
  return properties
    .filter((property) => operatorsFor(property.propertyType).length > 0)
    .map((property) => ({
      key: property.propertyId,
      name: property.name,
      type: property.propertyType,
    }))
}

export function isSortable(key: string, types: Record<string, string>): boolean {
  return key === TITLE_KEY || SORTABLE_TYPES.has(types[key] ?? "")
}
