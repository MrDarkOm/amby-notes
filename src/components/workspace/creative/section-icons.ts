import {
  BookOpen,
  Database,
  FileText,
  Globe2,
  Layers,
  MapPin,
  StickyNote,
  Users,
  type LucideIcon,
} from "lucide-react"
import type { ProjectSummary } from "@/lib/storage"

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

/** The icon of a project without one of its own: a story, a universe or a collection. */
export function projectFallbackIcon(project: ProjectSummary): LucideIcon {
  if (project.kind === "story") return BookOpen
  // A collection with its own world sections is a universe.
  return project.sections.length > 0 ? Globe2 : Layers
}
