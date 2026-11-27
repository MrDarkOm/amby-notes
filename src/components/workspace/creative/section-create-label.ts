import type { TFunction } from "i18next"

export function sectionCreateLabel(t: TFunction, role: string | null, name: string): string {
  switch (role) {
    case "characters":
    case "locations":
    case "arcs":
    case "anchors":
    case "notes":
    case "stories":
    case "universes":
      return t(`creative.createItem.${role}`)
    default:
      return t("creative.createItem.inSection", { name })
  }
}
