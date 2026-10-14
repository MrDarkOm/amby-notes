import {
  BookOpen,
  Feather,
  FilePlus,
  FileText,
  Globe2,
  Section,
  type LucideIcon,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import type { WorkshopSummary } from "@/lib/storage"

export type CreateChoice =
  | "workshop"
  | "story"
  | "section"
  | "universe"
  /** A new page in a world category: `entity:<category key>`. */
  | `entity:${string}`
  /** A new page of a story's text. */
  | "page"

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
 * What the "Create" button and the empty space context menu offer.
 */
export function useChooserOptions(
  workshop: WorkshopSummary | null,
  extra: ChooserExtra[] = [],
): ChooserOption[] {
  const { t } = useTranslation()
  const canWrite = workshop !== null && !workshop.readOnly

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
    ...(canWrite
      ? [
          {
            value: "story" as const,
            group: "rare" as const,
            icon: BookOpen,
            title: t("creative.panel.newStory", "Новая история"),
            hint: t("creative.chooser.storyInside", {
              name: workshop.name,
              defaultValue: `В мастерской «${workshop.name}»`,
            }),
          },
          {
            value: "universe" as const,
            group: "rare" as const,
            icon: Globe2,
            title: t("creative.kind.universe", "Вселенная"),
            hint: t("creative.kind.universeHint", "Мир или сеттинг для историй"),
          },
          {
            value: "section" as const,
            group: "rare" as const,
            icon: Section,
            title: t("creative.panel.newSection", "Новый раздел"),
            hint: t("creative.chooser.sectionHint", {
              name: workshop.name,
              defaultValue: `База данных в мастерской «${workshop.name}»`,
            }),
          },
        ]
      : []),
    {
      value: "workshop" as const,
      group: "rare" as const,
      icon: Feather,
      title: t("creative.panel.newWorkshop", "Новая мастерская"),
      hint: t("creative.createProject.description", "Корневая мастерская с базами и историями"),
    },
  ]
}
