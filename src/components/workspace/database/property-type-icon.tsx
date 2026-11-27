import { propertyTypeIcon } from "../property-type-icons"

/** The small icon of a property type. */
export function PropertyTypeIcon({ type }: { type: string }) {
  const Icon = propertyTypeIcon(type)
  return <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
}
