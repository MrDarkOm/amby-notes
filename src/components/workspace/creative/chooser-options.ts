import { BookOpen, FilePlus, FileText, Globe2, Section, type LucideIcon } from "lucide-react"
import { useTranslation } from "react-i18next"
import type { WorkshopSummary } from "@/lib/storage"

export type CreateChoice =
  | "story"
  | "section"
  | "universe"
  | "anchor"
  | "note"
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
  group: ChooserGroup
}

const CHOOSER_GROUPS = ["story", "reference", "structure"] as const
type ChooserGroup = (typeof CHOOSER_GROUPS)[number]

export function groupChooserOptions(options: ChooserOption[]) {
  return CHOOSER_GROUPS.map((group) => ({
    group,
    options: options.filter((option) => option.group === group),
  })).filter((item) => item.options.length > 0)
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
      icon: entry.icon ?? (entry.value === "page" ? FileText : FilePlus),
      group: entry.value.startsWith("entity:") ? "reference" : "story",
    })),
    ...(canWrite
      ? [
          {
            value: "story" as const,
            group: "structure" as const,
            icon: BookOpen,
            title: t("creative.panel.newStory", "Новая история"),
            hint: t("creative.chooser.storyInside", {
              name: workshop.name,
              defaultValue: `В мастерской «${workshop.name}»`,
            }),
          },
          {
            value: "universe" as const,
            group: "structure" as const,
            icon: Globe2,
            title: t("creative.kind.universe", "Вселенная"),
            hint: t("creative.kind.universeHint", "Мир или сеттинг для историй"),
          },
          {
            value: "section" as const,
            group: "structure" as const,
            icon: Section,
            title: t("creative.panel.newSection", "Новый раздел"),
            hint: t("creative.chooser.sectionHint", {
              name: workshop.name,
              defaultValue: `База данных в мастерской «${workshop.name}»`,
            }),
          },
        ]
      : []),
  ]
}
