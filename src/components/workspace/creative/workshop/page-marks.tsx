import { Anchor } from "lucide-react"
import { useTranslation } from "react-i18next"
import type { PageMarks } from "./plot-model"

/**
 * What a text row shows of the anchors and arcs bound to its page: an anchor with a number above
 * one, then a dot per arc (up to three) and "+N". It takes no room of its own beyond the marks, so
 * a row without bindings looks as it always did.
 */
export function PageMarksView({ marks }: { marks: PageMarks }) {
  const { t } = useTranslation()
  return (
    <span className="ml-1 inline-flex shrink-0 items-center gap-1.5" data-testid="page-marks">
      {marks.anchorCount > 0 && (
        <span
          className="inline-flex items-center gap-0.5 text-muted-foreground"
          title={t("creative.plot.marks.anchors", { names: marks.anchorTitles.join(", ") })}
          data-testid="page-anchor-mark"
        >
          <Anchor aria-hidden="true" className="size-3" />
          {marks.anchorCount > 1 && (
            <span className="text-[10px] leading-none tabular-nums">{marks.anchorCount}</span>
          )}
        </span>
      )}
      {marks.dots.length > 0 && (
        <span
          className="inline-flex items-center gap-0.5"
          title={t("creative.plot.marks.arcs", { names: marks.arcTitles.join(", ") })}
          data-testid="page-arc-marks"
        >
          {marks.dots.map((dot) => (
            <span
              key={dot.id}
              aria-hidden="true"
              data-arc-dot={dot.id}
              className="size-1.5 rounded-full"
              style={{ backgroundColor: dot.color }}
            />
          ))}
          {marks.more > 0 && (
            <span className="text-[10px] leading-none text-muted-foreground">+{marks.more}</span>
          )}
        </span>
      )}
    </span>
  )
}

/** A failed binding, on the row it belongs to. */
export function RowError({ message, indent }: { message: string; indent: number }) {
  return (
    <p
      role="alert"
      className="py-0.5 pr-3 text-[11px] text-destructive"
      style={{ paddingLeft: indent }}
    >
      {message}
    </p>
  )
}
