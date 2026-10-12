import * as React from "react"
import { ChevronRight, Plus, type LucideIcon } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { motion } from "motion/react"
import { motionTransitions } from "@/lib/motion-config"
import { treeIndent } from "./tree-indent"

interface AccordionProps {
  icon: LucideIcon
  /** Shown instead of `icon`, e.g. the icon the author gave a database. */
  iconNode?: React.ReactNode
  label: string
  /** A short explanation shown on hover: for a part whose name needs one (anchors). */
  hint?: string
  /** How many items are inside; nothing is shown for `null` or zero. */
  count?: number | null
  open: boolean
  onToggle: () => void
  /** Controls between the name and the add button (the world's story/universe switch). */
  extra?: React.ReactNode
  /** Adds an item to the part; `null` hides the button. It is always shown, quietly. */
  onAdd?: (() => void) | null
  addLabel?: string
  children: React.ReactNode
}

/** A folding part with an icon before its name, as used by the works tab and the world. */
export function Accordion({
  icon: Icon,
  iconNode,
  label,
  hint,
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
    <section>
      {/* The row is the file tree's own: the same classes, so the chevron takes the icon's place
          on hover and the density setting applies. */}
      <div className="amby-tree-row group flex items-center rounded pr-1 text-[13px] hover:bg-accent">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? t("creative.panel.collapse") : t("creative.panel.expand")}: ${label}`}
          onClick={onToggle}
          title={hint}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded py-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          style={{ paddingLeft: treeIndent(0) }}
        >
          <span className="amby-tree-folder-icon relative inline-flex size-4 shrink-0 items-center justify-center">
            <span className="amby-tree-main-icon flex text-muted-foreground">
              {iconNode ?? <Icon className="size-4" />}
            </span>
            <span
              aria-hidden="true"
              className="amby-tree-folder-toggle absolute inset-0 flex items-center justify-center text-muted-foreground"
            >
              <motion.span
                className="flex"
                initial={false}
                animate={{ rotate: open ? 90 : 0 }}
                transition={motionTransitions.default}
              >
                <ChevronRight className="size-3" />
              </motion.span>
            </span>
          </span>
          <span className="min-w-0 truncate">{label}</span>
          {count !== null && count > 0 && (
            <span className="text-[11px] text-muted-foreground">{count}</span>
          )}
        </button>
        {extra}
        {onAdd && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-6 text-muted-foreground opacity-60 hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
            title={addLabel}
            aria-label={addLabel}
            onClick={onAdd}
          >
            <Plus className="size-3.5" />
          </Button>
        )}
      </div>
      {open && <div>{children}</div>}
    </section>
  )
}
