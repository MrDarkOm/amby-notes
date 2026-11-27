import * as React from "react"
import { Target, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { isEnterKey } from "@/lib/keyboard"

/**
 * The daily word goal of a story under its progress: today's words against the goal, a bar, and
 * the days in a row that reached it. Setting or removing the goal changes only this device's
 * preferences; nothing is written to the vault.
 */
export function WordGoal({
  goal,
  written,
  streak,
  canEdit,
  onSetGoal,
}: {
  goal: number | null
  written: number
  streak: number
  canEdit: boolean
  onSetGoal: (goal: number | null) => void
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState("")

  const submit = () => {
    const value = Number(draft.trim())
    if (!Number.isInteger(value) || value <= 0) return
    onSetGoal(value)
    setEditing(false)
  }

  if (editing) {
    return (
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>{t("creative.goal.perDay")}</span>
        <input
          type="number"
          min={1}
          step={50}
          autoFocus
          value={draft}
          aria-label={t("creative.goal.perDay")}
          className="w-24 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-ring"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (isEnterKey(event)) submit()
            if (event.key === "Escape") setEditing(false)
          }}
          onBlur={() => setEditing(false)}
        />
      </label>
    )
  }

  if (goal === null) {
    return canEdit ? (
      <Button
        variant="ghost"
        size="sm"
        className="w-fit text-xs text-muted-foreground"
        onClick={() => {
          setDraft("500")
          setEditing(true)
        }}
      >
        <Target className="size-3.5" />
        {t("creative.goal.set")}
      </Button>
    ) : null
  }

  const percent = Math.min(100, Math.round((written / goal) * 100))
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-xs">
        <Target aria-hidden="true" className="size-3.5 text-muted-foreground" />
        <span className="font-medium">
          {t("creative.goal.today", {
            written: written.toLocaleString(),
            goal: goal.toLocaleString(),
          })}
        </span>
        {streak > 0 && (
          <span className="text-muted-foreground">
            {t("creative.goal.streak", { count: streak })}
          </span>
        )}
        {canEdit && (
          <button
            type="button"
            aria-label={t("creative.goal.remove")}
            title={t("creative.goal.remove")}
            className="ml-auto rounded p-0.5 text-muted-foreground hover:text-foreground"
            onClick={() => onSetGoal(null)}
          >
            <X aria-hidden="true" className="size-3" />
          </button>
        )}
      </div>
      <div
        role="progressbar"
        aria-label={t("creative.goal.label")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 w-full overflow-hidden rounded-full bg-accent"
      >
        <span
          className={percent >= 100 ? "block h-full bg-primary" : "block h-full bg-primary/50"}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}
