import { useTranslation } from "react-i18next"
import type { DatabaseRow, DatabasePropertySummary } from "@/lib/storage"
import { PropertyValue } from "./property-value"
import { cardProperties } from "./value-format"

interface DatabaseValueCellProps {
  row: DatabaseRow
  properties: DatabasePropertySummary[]
  relationTitles?: Record<string, string>
  /** Property IDs shown elsewhere on the card (for example the Board group). */
  exclude?: string[]
  limit?: number
  /** Properties chosen for the view's cards; `null` shows the first few non-empty ones. */
  fields?: string[] | null
}

/** Compact, schema-aware values for Gallery, List and Board cards. */
export function DatabaseValueCell({
  row,
  properties,
  relationTitles,
  exclude,
  limit,
  fields,
}: DatabaseValueCellProps) {
  const { i18n } = useTranslation()
  const shown = cardProperties(row.valuesJson, properties, {
    relationTitles,
    exclude,
    limit,
    fields,
    locale: i18n.language,
  })
  if (shown.length === 0) return null
  return (
    <span className="mt-2 flex min-w-0 flex-col gap-1">
      {shown.map((property) => (
        <PropertyValue key={property.propertyId} property={property} />
      ))}
    </span>
  )
}
