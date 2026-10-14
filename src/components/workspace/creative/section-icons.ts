import {
  Anchor,
  BookOpen,
  Database,
  Feather,
  FileText,
  GitBranch,
  Globe2,
  MapPin,
  StickyNote,
  Users,
  type LucideIcon,
} from "lucide-react"
import type { StorySummary, WorkshopSummary } from "@/lib/storage"

const ROLE_ICONS: Record<string, LucideIcon> = {
  text: FileText,
  notes: StickyNote,
  characters: Users,
  locations: MapPin,
  stories: BookOpen,
  universes: Globe2,
  arcs: GitBranch,
  anchors: Anchor,
}

/** The icon a section shows when its database has none of its own. */
export function sectionRoleIcon(role: string | null): LucideIcon {
  return (role && ROLE_ICONS[role]) || Database
}

/** The fallback icon of a story or workshop. */
export function projectFallbackIcon(
  project: StorySummary | WorkshopSummary | { role?: string; icon?: string | null },
): LucideIcon {
  if ("storyId" in project) return BookOpen
  if ("workshopId" in project) return Feather
  return Feather
}
