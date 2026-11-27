import { propertyTypeIcon } from "../property-type-icons"
import type { DatabasePropertySummary, FrontmatterProperty } from "@/lib/storage"

export const PROPERTY_TYPE_FALLBACKS = {
  text: "Текст",
  number: "Число",
  checkbox: "Флажок",
  date: "Дата",
  select: "Выбор",
  list: "Мультивыбор",
  url: "Ссылка",
} as const

export function databasePropertyIcon(property: Pick<DatabasePropertySummary, "propertyType">) {
  return propertyTypeIcon(property.propertyType)
}

/** The type of a header key when the note keeps no record of its own for it. */
function inferredType(property: FrontmatterProperty): string {
  const key = property.key.trim().toLowerCase()
  if (key === "tags" || key === "tag" || key === "keywords") return "list"
  if (["date", "due", "created", "modified", "deadline"].includes(key)) return "date"
  if (
    property.valueKind === "checkbox" ||
    property.value === "true" ||
    property.value === "false"
  ) {
    return "checkbox"
  }
  if (property.valueKind === "number") return "number"
  if (property.valueKind === "list") return "list"
  if (
    property.valueKind === "url" ||
    property.value.startsWith("http://") ||
    property.value.startsWith("https://")
  ) {
    return "url"
  }
  return "text"
}

/** The icon of a type is the same in the panel of a note and in databases (З61). */
export function frontmatterPropertyIcon(property: FrontmatterProperty, propertyType?: string) {
  return propertyTypeIcon(propertyType ?? inferredType(property))
}
