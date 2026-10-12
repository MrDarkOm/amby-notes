import {
  BookOpen,
  FilePlus,
  FileText,
  Globe2,
  Layers,
  Section,
  type LucideIcon,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import type { ProjectSummary } from "@/lib/storage"
import { writableCollection } from "./project-tree-model"

export type CreateChoice =
  | "story"
  | "section"
  | "universe"
  | "collection"
  /** A new page in a world category: `entity:<category key>`. */
  | `entity:${string}`
  /** A new page of a story's text. */
  | "page"
  /** A new section of one story: `section:<project ID>`. */
  | `section:${string}`

export interface ChooserExtra {
  value: CreateChoice
  title: string
  hint: string
}

export interface ChooserOption {
  value: CreateChoice
  icon: LucideIcon
  title: string
  hint: string
}

/**
 * What the "Create" button, and the menu of the empty space, offer: what the open lists add
 * (`extra`, first), then a story, a section of the shown collection, a universe, a collection.
 */
export function useChooserOptions(
  scope: ProjectSummary | null,
  extra: ChooserExtra[] = [],
): ChooserOption[] {
  const { t } = useTranslation()
  const collection = writableCollection(scope)
  return [
    ...extra.map((entry) => ({
      ...entry,
      icon:
        entry.value === "page" ? FileText : entry.value.startsWith("section:") ? Section : FilePlus,
    })),
    {
      value: "story",
      icon: BookOpen,
      title: t("creative.chooser.story"),
      hint: collection
        ? t("creative.chooser.storyInside", { name: collection.name })
        : t("creative.chooser.storyAlone"),
    },
    ...(collection
      ? [
          {
            value: "section" as const,
            icon: Section,
            title: t("creative.chooser.section"),
            hint: t("creative.chooser.sectionHint", { name: collection.name }),
          },
        ]
      : []),
    {
      value: "universe",
      icon: Globe2,
      title: t("creative.kind.universe"),
      hint: t("creative.kind.universeHint"),
    },
    {
      value: "collection",
      icon: Layers,
      title: t("creative.kind.collection"),
      hint: t("creative.kind.collectionHint"),
    },
  ]
}
