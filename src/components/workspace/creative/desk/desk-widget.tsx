import type * as React from "react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"

interface DeskWidgetProps {
  title: string
  /** A number beside the title (how many pages, notes, characters…). */
  count?: number | null
  /** The quiet "Open" at the right: leads to the section's own tab. */
  onOpen?: (() => void) | null
  /** Controls of the layout mode, at the right of the header; none outside that mode. */
  controls?: React.ReactNode
  className?: string
  style?: React.CSSProperties
  children: React.ReactNode
}

/** One card of the desk: a header (title, count, "Open") over the widget's own content. */
export function DeskWidget({
  title,
  count = null,
  onOpen,
  controls,
  className,
  style,
  children,
}: DeskWidgetProps) {
  const { t } = useTranslation()
  return (
    <section
      aria-label={title}
      style={style}
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-2xl border border-border bg-card px-[18px] py-4",
        className,
      )}
    >
      <header className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1">
        <h2 className="min-w-0 break-words text-[15px] font-semibold">{title}</h2>
        {count !== null && (
          <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {onOpen && (
            <button
              type="button"
              onClick={onOpen}
              className="rounded-md px-2 py-1 text-[13px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
            >
              {t("creative.desk.open")}
              <span className="sr-only"> {title}</span>
            </button>
          )}
          {controls}
        </div>
      </header>
      {children}
    </section>
  )
}
