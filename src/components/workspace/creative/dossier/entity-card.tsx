import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import { initialsOf } from "../workshop/workshop-model"

const CARD_WIDTH = 224
const GAP = 6

/**
 * The card of a name pointed at in the text: who or what it is and how to open its page. It is
 * placed under the name (above it near the bottom of the window) and never takes the pointer, so
 * reading and selecting the text go on as before.
 */
export function EntityCard({
  title,
  kind,
  anchor,
}: {
  title: string
  /** The section it belongs to, e.g. "Characters". */
  kind: string
  anchor: DOMRect
}) {
  const { t } = useTranslation()
  const below = anchor.bottom + GAP + 72 < window.innerHeight
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - CARD_WIDTH - 8))
  return createPortal(
    <div
      role="tooltip"
      className="pointer-events-none fixed z-50 flex items-center gap-2.5 rounded-lg border border-border bg-popover px-3 py-2 text-popover-foreground shadow-md"
      style={{
        left,
        width: CARD_WIDTH,
        ...(below
          ? { top: anchor.bottom + GAP }
          : { bottom: window.innerHeight - anchor.top + GAP }),
      }}
    >
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-xs text-muted-foreground"
      >
        {initialsOf(title)}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">{title}</span>
        <span className="truncate text-[11px] text-muted-foreground">{kind}</span>
        <span className="truncate text-[11px] text-muted-foreground">
          {t("creative.dossier.entityCardOpen")}
        </span>
      </span>
    </div>,
    document.body,
  )
}
