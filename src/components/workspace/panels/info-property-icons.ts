import {
  CalendarDays,
  CheckSquare,
  Hash,
  Link2,
  List,
  Paperclip,
  Tags,
  Type,
  Waypoints,
} from "lucide-react"
import type { DatabasePropertySummary, FrontmatterProperty } from "@/lib/storage"

export const PROPERTY_TYPE_FALLBACKS = {
  text: "Текст",
  number: "Число",
  checkbox: "Флажок",
  date: "Дата",
  select: "Выбор",
  url: "Ссылка",
} as const

export function databasePropertyIcon(property: Pick<DatabasePropertySummary, "propertyType">) {
  return property.propertyType === "number"
    ? Hash
    : property.propertyType === "checkbox"
      ? CheckSquare
      : property.propertyType === "date"
        ? CalendarDays
        : property.propertyType === "url"
          ? Link2
          : property.propertyType === "select"
            ? List
            : property.propertyType === "multiSelect" || property.propertyType === "status"
              ? Tags
              : property.propertyType === "files"
                ? Paperclip
                : property.propertyType === "relation"
                  ? Waypoints
                  : Type
}

export function frontmatterPropertyIcon(property: FrontmatterProperty, propertyType?: string) {
  if (propertyType === "checkbox") return CheckSquare
  if (propertyType === "number") return Hash
  if (propertyType === "date") return CalendarDays
  if (propertyType === "select") return List
  if (propertyType === "url") return Link2
  if (propertyType === "text") {
    const key = property.key.trim().toLowerCase()
    if (key === "tags" || key === "tag" || key === "keywords") return Tags
    return Type
  }

  const key = property.key.trim().toLowerCase()
  if (key === "tags" || key === "tag" || key === "keywords") return Tags
  if (
    key === "date" ||
    key === "due" ||
    key === "created" ||
    key === "modified" ||
    key === "deadline"
  ) {
    return CalendarDays
  }
  if (
    property.valueKind === "checkbox" ||
    property.value === "true" ||
    property.value === "false"
  ) {
    return CheckSquare
  }
  if (property.valueKind === "number") return Hash
  if (property.valueKind === "list") return List
  if (
    property.valueKind === "url" ||
    property.value.startsWith("http://") ||
    property.value.startsWith("https://")
  ) {
    return Link2
  }
  return Type
}
