import { motion } from "motion/react"
import { Columns3 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { motionTransition } from "@/lib/motion-config"
import { cardSpring } from "./database-motion"
import type { DatabasePropertySummary } from "@/lib/storage"

interface BoardGroupPromptProps {
  /** Select and Status properties that can split the board into columns. */
  candidates: DatabasePropertySummary[]
  disabled?: boolean
  onPick: (propertyId: string) => void
}

/** Shown above a board with no columns yet: one click splits it by a property. */
export function BoardGroupPrompt({ candidates, disabled, onPick }: BoardGroupPromptProps) {
  const { t } = useTranslation()
  return (
    <motion.div
      role="region"
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={motionTransition(cardSpring)}
      aria-label={t("databaseWorkspace.groupBy")}
      className="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
    >
      <Columns3 className="size-4 shrink-0" aria-hidden="true" />
      {candidates.length === 0 ? (
        <span>{t("databaseWorkspace.groupByHint")}</span>
      ) : (
        <>
          <span>{t("databaseWorkspace.groupByPrompt")}</span>
          {candidates.map((property) => (
            <Button
              key={property.propertyId}
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={disabled}
              onClick={() => onPick(property.propertyId)}
            >
              {property.name}
            </Button>
          ))}
        </>
      )}
    </motion.div>
  )
}
