import type { DatabaseRow } from "@/lib/storage"

interface DatabaseValueCellProps {
  row: DatabaseRow
}

export function DatabaseValueCell({ row }: DatabaseValueCellProps) {
  const values = parseValues(row.valuesJson)
  if (values.length === 0) return null
  return (
    <span className="mt-2 flex min-w-0 flex-wrap gap-1">
      {values.map((value, index) => (
        <span
          key={`${value.kind}-${value.text}-${index}`}
          className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
        >
          {value.text}
        </span>
      ))}
    </span>
  )
}

interface DisplayValue {
  kind: string
  text: string
}

function parseValues(valuesJson: string): DisplayValue[] {
  let values: unknown
  try {
    values = JSON.parse(valuesJson)
  } catch {
    return []
  }
  if (!values || typeof values !== "object") return []
  return Object.values(values as Record<string, unknown>).flatMap((value) => {
    if (!value || typeof value !== "object") return []
    const typed = value as Record<string, unknown>
    switch (typed.type) {
      case "text":
      case "url":
        return typeof typed.value === "string" ? [{ kind: typed.type, text: typed.value }] : []
      case "number":
        return typeof typed.decimal === "string" ? [{ kind: typed.type, text: typed.decimal }] : []
      case "checkbox":
        return typeof typed.checked === "boolean"
          ? [{ kind: typed.type, text: typed.checked ? "✓" : "–" }]
          : []
      case "date":
        return typeof typed.start === "string" ? [{ kind: typed.type, text: typed.start }] : []
      case "select":
      case "status":
        return typeof typed.optionId === "string"
          ? [{ kind: typed.type, text: typed.optionId }]
          : []
      case "multiSelect":
        return Array.isArray(typed.optionIds)
          ? typed.optionIds
              .filter((item): item is string => typeof item === "string")
              .map((text) => ({ kind: typed.type as string, text }))
          : []
      case "relation":
        return Array.isArray(typed.targetNoteIds)
          ? typed.targetNoteIds
              .filter((item): item is string => typeof item === "string")
              .map((text) => ({ kind: typed.type as string, text }))
          : []
      case "files":
        return Array.isArray(typed.items)
          ? typed.items.flatMap((item) => {
              if (!item || typeof item !== "object") return []
              const name = (item as { name?: unknown }).name
              return typeof name === "string" ? [{ kind: typed.type as string, text: name }] : []
            })
          : []
      default:
        return []
    }
  })
}
