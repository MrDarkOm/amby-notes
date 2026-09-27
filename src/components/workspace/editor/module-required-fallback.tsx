"use client"

import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Code2, FileQuestion, Power, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"

export interface ModuleRequiredFallbackProps {
  moduleId: string
  moduleName: string
  rawContent?: string
  onEnableModule?: () => void
}

export function ModuleRequiredFallback({
  moduleName,
  rawContent,
  onEnableModule,
}: ModuleRequiredFallbackProps) {
  const { t } = useTranslation()
  const [showSource, setShowSource] = useState(false)

  return (
    <div className="flex h-full w-full flex-col items-center justify-center p-6 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl border border-border bg-card shadow-sm">
        <FileQuestion className="size-7 text-muted-foreground" />
      </div>

      <h2 className="mt-4 text-base font-semibold text-foreground">
        {t("moduleRequired.title", { name: moduleName })}
      </h2>

      <p className="mt-2 max-w-md text-xs leading-relaxed text-muted-foreground">
        {t("moduleRequired.description")}
      </p>

      <div className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground/80">
        <ShieldCheck className="size-3.5 text-emerald-500" />
        <span>{t("moduleRequired.filePreserved")}</span>
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        {onEnableModule && (
          <Button size="sm" onClick={onEnableModule} className="flex items-center gap-1.5 text-xs">
            <Power className="size-3.5" />
            {t("moduleRequired.enableModule")}
          </Button>
        )}

        {rawContent !== undefined && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowSource(!showSource)}
            className="flex items-center gap-1.5 text-xs"
          >
            <Code2 className="size-3.5" />
            {showSource ? t("moduleRequired.hideSource") : t("moduleRequired.viewSource")}
          </Button>
        )}
      </div>

      {showSource && rawContent !== undefined && (
        <div className="mt-6 w-full max-w-2xl rounded-lg border border-border bg-muted/40 p-4 text-left">
          <pre className="max-h-72 overflow-auto font-mono text-[11px] text-foreground">
            {rawContent}
          </pre>
        </div>
      )}
    </div>
  )
}
