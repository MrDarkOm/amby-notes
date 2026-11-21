"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { Hand, Shield, ShieldAlert } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import type { ApprovalMode } from "./use-proposal-store"

const MODES: ApprovalMode[] = ["manual", "auto", "turbo"]

export function ApprovalIcon({ mode, className }: { mode: ApprovalMode; className?: string }) {
  if (mode === "manual") return <Hand aria-hidden="true" className={className} />
  if (mode === "auto") return <Shield aria-hidden="true" className={className} />
  return <ShieldAlert aria-hidden="true" className={cn("text-destructive", className)} />
}

/** How the AI's changes to notes are approved: by hand, automatically, or without any stop. */
export function ApprovalModeButton({
  mode,
  disabled,
  onChange,
}: {
  mode: ApprovalMode
  disabled?: boolean
  onChange: (mode: ApprovalMode) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          title={t(`ai.approval.${mode}.label`)}
          aria-label={t("ai.approval.title")}
          aria-haspopup="menu"
          aria-expanded={open}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          <ApprovalIcon mode={mode} className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" sideOffset={6} className="w-64 p-1">
        <div role="menu" aria-label={t("ai.approval.title")} className="flex flex-col">
          {MODES.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="menuitemradio"
              aria-checked={candidate === mode}
              onClick={() => {
                setOpen(false)
                onChange(candidate)
              }}
              className={cn(
                "flex items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent",
                candidate === mode && "bg-accent/60",
              )}
            >
              <ApprovalIcon mode={candidate} className="mt-0.5 size-3.5 shrink-0" />
              <span className="flex min-w-0 flex-col">
                <span className="font-medium text-foreground">
                  {t(`ai.approval.${candidate}.label`)}
                </span>
                <span className="text-muted-foreground">{t(`ai.approval.${candidate}.hint`)}</span>
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
