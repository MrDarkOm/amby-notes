import { Database, FileText, MapPin, StickyNote, Users, type LucideIcon } from "lucide-react"

const ROLE_ICONS: Record<string, LucideIcon> = {
  text: FileText,
  notes: StickyNote,
  characters: Users,
  locations: MapPin,
}

/** The icon a section shows when its database has none of its own. */
export function sectionRoleIcon(role: string | null): LucideIcon {
  return (role && ROLE_ICONS[role]) || Database
}
