"use client"

import { useTranslation } from "react-i18next"
import { Sparkles } from "lucide-react"

const SUGGESTIONS = ["ai.suggestSummarize", "ai.suggestLinks", "ai.suggestTasks"] as const

/** Shown before the first message: what the assistant sees, and three ways to start. */
export function EmptyChat({
  hasModel,
  searchOn,
  onOpenModels,
  onPick,
}: {
  hasModel: boolean
  searchOn: boolean
  onOpenModels: () => void
  onPick: (text: string) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col items-start gap-3 px-1 py-8">
      <Sparkles className="size-5 text-muted-foreground" aria-hidden="true" />
      <div>
        <p className="text-[15px] font-medium text-foreground">{t("ai.emptyTitle")}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {t(searchOn ? "ai.emptyHintSearch" : "ai.emptyHint")}
        </p>
      </div>
      {hasModel ? (
        <div className="flex w-full flex-col gap-1.5">
          {SUGGESTIONS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => onPick(t(key))}
              className="rounded-lg border border-border px-3 py-1.5 text-left text-xs text-foreground hover:bg-accent"
            >
              {t(key)}
            </button>
          ))}
        </div>
      ) : (
        <button
          type="button"
          className="rounded-lg border border-border px-3 py-1.5 text-xs text-foreground hover:bg-accent"
          onClick={onOpenModels}
        >
          {t("ai.noModelsOpenSettings")}
        </button>
      )}
    </div>
  )
}
