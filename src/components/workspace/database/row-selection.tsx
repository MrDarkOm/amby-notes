import { Check, Trash2, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"

/** A row's checkbox. Hidden until the row is hovered, unless something is selected. */
export function RowCheckbox({
  checked,
  onToggle,
  label,
  className,
}: {
  checked: boolean
  onToggle: () => void
  label: string
  className?: string
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      title={label}
      data-no-drag=""
      className={cn(
        "database-row-checkbox flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-muted-foreground/50 text-white outline-none focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        onToggle()
      }}
    >
      {checked && <Check className="size-3" strokeWidth={3} />}
    </button>
  )
}

/** What can be done to all ticked rows at once. */
export function RowSelectionBar({
  count,
  top,
  onClear,
  onDelete,
}: {
  count: number
  /** Distance from the top of the table: the bar sits on its header line, at the left. */
  top: number
  onClear: () => void
  onDelete?: () => void
}) {
  const { t } = useTranslation()
  if (count === 0) return null
  return (
    <div
      role="toolbar"
      aria-label={t("databaseRowMenu.selected", { count })}
      className="absolute left-2 z-30 flex h-8 items-center gap-0.5 rounded-lg border border-border bg-popover px-1 text-sm text-popover-foreground shadow-md"
      style={{ top }}
    >
      <span className="px-2 text-[13px] font-medium">
        {t("databaseRowMenu.selected", { count })}
      </span>
      {onDelete && (
        <button
          type="button"
          className="flex h-6 items-center gap-1.5 rounded-md px-2 text-[13px] text-destructive outline-none hover:bg-destructive/10 focus-visible:ring-1 focus-visible:ring-ring"
          onClick={onDelete}
        >
          <Trash2 className="size-3.5" />
          {t("databaseRowMenu.delete")}
        </button>
      )}
      <button
        type="button"
        aria-label={t("databaseRowMenu.clearSelection")}
        title={t("databaseRowMenu.clearSelection")}
        className="flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        onClick={onClear}
      >
        <X className="size-4" />
      </button>
    </div>
  )
}
