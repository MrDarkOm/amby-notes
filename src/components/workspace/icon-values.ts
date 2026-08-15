import { icons, type LucideIcon } from "lucide-react"

export const ICON_VALUE_PREFIX = "amby-icon:"

function iconName(name: string) {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/gu, "$1-$2")
    .toLowerCase()
}

/** The complete Lucide library, kept searchable instead of maintaining a short curated subset. */
export const PICKER_ICONS: Array<[string, LucideIcon]> = Object.entries(icons)
  .map(([name, Icon]) => [iconName(name), Icon] as [string, LucideIcon])
  .sort(([left], [right]) => left.localeCompare(right))

const ICONS = Object.fromEntries(PICKER_ICONS) as Record<string, LucideIcon>

export function makeIconValue(name: string, color: string) {
  return `${ICON_VALUE_PREFIX}${name}:${encodeURIComponent(color)}`
}

export function parseIconValue(value?: string) {
  if (!value?.startsWith(ICON_VALUE_PREFIX)) return null
  const payload = value.slice(ICON_VALUE_PREFIX.length)
  const separator = payload.indexOf(":")
  if (separator < 1) return null
  const name = payload.slice(0, separator)
  const Icon = ICONS[name]
  if (!Icon) return null
  return { Icon, name, color: decodeURIComponent(payload.slice(separator + 1)) }
}

export function isRichIconValue(value?: string) {
  return Boolean(
    value && (/^data:image\/(?:png|jpeg|webp);base64,/u.test(value) || parseIconValue(value)),
  )
}
