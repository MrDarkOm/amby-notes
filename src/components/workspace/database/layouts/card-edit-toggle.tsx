import { motion } from "motion/react"
import { Check, Pencil } from "lucide-react"
import { useTranslation } from "react-i18next"
import { motionTransitions } from "@/lib/motion-config"
import { cn } from "@/lib/utils"
import { pencilVariants } from "../database-motion"

interface CardEditToggleProps {
  editing: boolean
  /** The card is hovered or holds focus: the pencil shows. */
  active: boolean
  onToggle: () => void
}

/**
 * The pencil in the corner of a card. Properties of a card are only editable
 * after pressing it, so a click or a drag on the card never changes a value
 * by accident. It fades in when the card is hovered or focused, and stays
 * while editing.
 */
export function CardEditToggle({ editing, active, onToggle }: CardEditToggleProps) {
  const { t } = useTranslation()
  const label = editing ? t("databaseCard.done") : t("databaseCard.edit")
  return (
    <motion.button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={editing}
      data-no-drag=""
      variants={pencilVariants}
      initial="rest"
      animate={editing || active ? "hover" : "rest"}
      whileFocus="hover"
      whileTap={{ scale: 0.88 }}
      transition={motionTransitions.fast}
      className={cn(
        "absolute right-1.5 top-1.5 z-10 flex size-6 items-center justify-center rounded-md border border-border/60 bg-card/95 text-muted-foreground shadow-sm outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
        editing && "border-primary/40 text-primary",
      )}
      onClick={(event) => {
        event.stopPropagation()
        onToggle()
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {editing ? <Check className="size-3.5" /> : <Pencil className="size-3.5" />}
    </motion.button>
  )
}
