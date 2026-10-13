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
  icon?: LucideIcon
}

export interface ChooserOption {
  value: CreateChoice
  icon: LucideIcon
  title: string
  hint: string
  /** What is made often (a page, a world page) comes first; the rest is offered after it. */
  group: "common" | "rare"
}

/** The options split into the frequent ones and the rare ones, each in its own order. */
export function splitChooserOptions(options: ChooserOption[]): {
  common: ChooserOption[]
  rare: ChooserOption[]
} {
  return {
    common: options.filter((option) => option.group === "common"),
    rare: options.filter((option) => option.group === "rare"),
  }
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
    ...extra.map((entry): ChooserOption => ({
      ...entry,
      icon:
        entry.icon ??
        (entry.value === "page"
          ? FileText
          : entry.value.startsWith("section:")
            ? Section
            : FilePlus),
      group: entry.value === "page" || entry.value.startsWith("entity:") ? "common" : "rare",
    })),
    {
      value: "story",
      group: "rare" as const,
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
            group: "rare" as const,
            icon: Section,
            title: t("creative.chooser.section"),
            hint: t("creative.chooser.sectionHint", { name: collection.name }),
          },
        ]
      : []),
    {
      value: "universe",
      group: "rare" as const,
      icon: Globe2,
      title: t("creative.kind.universe"),
      hint: t("creative.kind.universeHint"),
    },
    {
      value: "collection",
      group: "rare" as const,
      icon: Layers,
      title: t("creative.kind.collection"),
      hint: t("creative.kind.collectionHint"),
    },
  ]
}
