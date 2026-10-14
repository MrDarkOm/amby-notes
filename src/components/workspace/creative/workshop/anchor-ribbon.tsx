import * as React from "react"
import { Anchor, Check } from "lucide-react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import type { RibbonItem } from "./plot-views"
import { projectErrorText } from "../project-error"
import { QuickCreate } from "./quick-create"

interface AnchorRibbonProps {
  items: readonly RibbonItem<{ noteId: string; title: string }>[]
  /** The title of a page of the story's text. */
  pageTitleOf: (pageId: string) => string
  onOpen: (noteId: string) => void
  /** The anchors are still being read: an empty list is not yet "no anchors". */
  loading?: boolean
  /** Makes an anchor of the story under the typed name; `null` where one cannot be made. */
  onCreate: ((title: string) => Promise<void>) | null
}

/**
 * The anchors of a story along its text: the bound ones in the order of the text, each with the
 * first page it stands on (and a mark once that page is done), then the ones still "ahead". With
 * none, a quiet line and the way to make the first.
 */
export function AnchorRibbon({
  items,
  pageTitleOf,
  onOpen,
  loading = false,
  onCreate,
}: AnchorRibbonProps) {
  const { t } = useTranslation()
  const form = onCreate ? (
    <QuickCreate
      label={t("creative.plot.ribbon.create")}
      placeholder={t("creative.plot.ribbon.creating")}
      failed={(message) => t("creative.plot.ribbon.failed", { message })}
      onCreate={onCreate}
      describe={(caught) => projectErrorText(t, caught)}
    />
  ) : null

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-start gap-1">
        {!loading && (
          <p className="text-xs text-muted-foreground">{t("creative.plot.ribbon.empty")}</p>
        )}
        {!loading && form}
      </div>
    )
  }

  const firstAhead = items.findIndex((item) => item.pageId === null)
  return (
    <div className="flex flex-col gap-2">
      <ol className="flex flex-wrap items-stretch gap-2">
        {items.map((item, index) => (
          <React.Fragment key={item.row.noteId}>
            {index === firstAhead && index > 0 && (
              <li
                aria-hidden="true"
                className="flex items-center px-1 text-[11px] text-muted-foreground"
              >
                {t("creative.plot.ahead")}
              </li>
            )}
            <li className="min-w-0">
              <button
                type="button"
                onClick={() => onOpen(item.row.noteId)}
                className={cn(
                  "flex h-full max-w-56 flex-col items-start gap-0.5 rounded-lg border border-border px-2.5 py-1.5 text-left hover:bg-accent",
                  item.pageId === null && "border-dashed",
                  item.done && "bg-accent/40",
                )}
              >
                <span className="flex w-full min-w-0 items-center gap-1.5 text-[13px] font-medium">
                  <Anchor className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{item.row.title}</span>
                </span>
                {item.pageId !== null && (
                  <span className="flex w-full min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
                    <span className="truncate">{pageTitleOf(item.pageId)}</span>
                    {item.done && (
                      <span className="flex shrink-0 items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                        <Check className="size-3" aria-hidden="true" />
                        {t("creative.plot.passed")}
                      </span>
                    )}
                  </span>
                )}
              </button>
            </li>
          </React.Fragment>
        ))}
      </ol>
      {form}
    </div>
  )
}
