import { GalleryHorizontalEnd, LayoutGrid } from "lucide-react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import type { StoriesView } from "./story-list-model"

interface StoriesViewSwitchProps {
  view: StoriesView
  onChange: (view: StoriesView) => void
}

/** "Cards | Timeline": two buttons of one segmented group, each with an icon and its name. */
export function StoriesViewSwitch({ view, onChange }: StoriesViewSwitchProps) {
  const { t } = useTranslation()
  const options = [
    { id: "cards", Icon: LayoutGrid, label: t("creative.storiesView.cards") },
    { id: "timeline", Icon: GalleryHorizontalEnd, label: t("creative.storiesView.timeline") },
  ] as const
  return (
    <div
      role="group"
      aria-label={t("creative.storiesView.label")}
      className="flex gap-1 rounded-lg bg-accent/60 p-0.5"
    >
      {options.map(({ id, Icon, label }) => (
        <button
          key={id}
          type="button"
          aria-pressed={view === id}
          onClick={() => onChange(id)}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring",
            view === id
              ? "bg-background font-semibold text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className="size-3.5" />
          {label}
        </button>
      ))}
    </div>
  )
}
