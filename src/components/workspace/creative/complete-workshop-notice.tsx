import { Wrench } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import type { WorkshopGaps } from "./workshop-gaps"
import type { CompleteWorkshopState } from "./use-complete-workshop"

interface CompleteWorkshopNoticeProps {
  gaps: WorkshopGaps
  state: CompleteWorkshopState
}

/**
 * What a workshop made before the whole set was created at once lacks, with the one button that
 * adds it. Shown only when something is missing; opening the workshop wrote nothing to find out.
 */
export function CompleteWorkshopNotice({ gaps, state }: CompleteWorkshopNoticeProps) {
  const { t } = useTranslation()
  const names = gaps.roles.map((role) => t(`creative.sections.${role}`)).join(", ")
  return (
    <div
      data-testid="complete-workshop-notice"
      className="mx-3 mb-2 min-w-0 rounded-md border border-border bg-accent/40 p-2 text-[11px]"
    >
      <p className="flex items-start gap-1.5 font-medium text-foreground">
        <Wrench className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 break-words">{t("creative.complete.title")}</span>
      </p>
      <p className="mt-1 break-words text-muted-foreground">
        {gaps.roles.length > 0 && t("creative.complete.sections", { names })}
        {gaps.roles.length > 0 && gaps.links.length > 0 && " "}
        {gaps.links.length > 0 && t("creative.complete.links")}
      </p>
      <Button
        size="sm"
        variant="outline"
        className="mt-2 h-auto min-h-7 w-full whitespace-normal py-1 text-left"
        disabled={state.pending}
        onClick={() => void state.run()}
      >
        {state.pending ? t("creative.complete.working") : t("creative.complete.button")}
      </Button>
      {state.error && (
        <p role="alert" className="mt-1.5 break-words text-destructive">
          {state.error}
        </p>
      )}
      {state.skipped.length > 0 && (
        <p className="mt-1.5 break-words text-muted-foreground">
          {t("creative.complete.skipped", { items: state.skipped.join(", ") })}
        </p>
      )}
    </div>
  )
}
