import * as React from "react"
import { ChevronDown, ChevronRight, Plus, type LucideIcon } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"

interface AccordionProps {
  icon: LucideIcon
  /** Shown instead of `icon`, e.g. the icon the author gave a database. */
  iconNode?: React.ReactNode
  label: string
  /** How many items are inside; nothing is shown for `null` or zero. */
  count?: number | null
  open: boolean
  onToggle: () => void
  /** Controls between the name and the add button (the world's story/universe switch). */
  extra?: React.ReactNode
  /** Adds an item to the part; `null` hides the button. */
  onAdd?: (() => void) | null
  addLabel?: string
  children: React.ReactNode
}

/** A folding part with an icon before its name, as used by the works tab and the world. */
export function Accordion({
  icon: Icon,
  iconNode,
  label,
  count = null,
  open,
  onToggle,
  extra,
  onAdd = null,
  addLabel = "",
  children,
}: AccordionProps) {
  const { t } = useTranslation()
  return (
    <section className="mb-1">
      <div className="group flex items-center gap-1 rounded-md hover:bg-accent/40">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? t("creative.panel.collapse") : t("creative.panel.expand")}: ${label}`}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-1.5 text-left text-xs font-medium"
        >
          {open ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
            {iconNode ?? <Icon className="size-4" />}
          </span>
          <span className="min-w-0 truncate">{label}</span>
          {count !== null && count > 0 && (
            <span className="text-[11px] font-normal text-muted-foreground">{count}</span>
          )}
        </button>
        {extra}
        {onAdd && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
            title={addLabel}
            aria-label={addLabel}
            onClick={onAdd}
          >
            <Plus className="size-3.5" />
          </Button>
        )}
      </div>
      {open && <div className="pl-5">{children}</div>}
    </section>
  )
}
