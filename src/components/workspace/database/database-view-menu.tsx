"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"

/** A toolbar toggle for the filter or sort panel, with a badge for active rules. */
export function QueryPanelButton({
  icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  count: number
  active: boolean
  onClick: () => void
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="relative size-8 p-0 text-slate-500 hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
    >
      {icon}
      {count > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-medium leading-3.5 text-primary-foreground">
          {count}
        </span>
      )}
    </Button>
  )
}
