"use client"

import { useTranslation } from "react-i18next"
import { ChevronRight } from "lucide-react"
import type { SettingsSectionId } from "../settings-navigation"
import { SettingsIntro } from "./settings-common"

export interface SearchResultItem {
  section: SettingsSectionId
  label: string
  description: string
  targetId?: string
}

export function SearchResults({
  query,
  results,
  onOpen,
}: {
  query: string
  results: SearchResultItem[]
  onOpen: (section: SettingsSectionId, targetId?: string) => void
}) {
  const { t } = useTranslation()
  return (
    <div>
      <SettingsIntro
        title={t("settings.search.title", { query })}
        description={t("settings.search.count", { count: results.length })}
      />
      {results.length > 0 ? (
        <div className="mt-5 divide-y divide-border overflow-hidden rounded-lg border border-border">
          {results.map((result, index) => (
            <button
              key={`${result.section}-${result.label}-${index}`}
              type="button"
              onClick={() => onOpen(result.section, result.targetId)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-card"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] text-foreground">{result.label}</span>
                <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                  {result.description}
                </span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </div>
      ) : (
        <div className="mt-5 rounded-lg border border-dashed border-border px-6 py-12 text-center text-[13px] text-muted-foreground">
          {t("settings.search.empty")}
        </div>
      )}
    </div>
  )
}
