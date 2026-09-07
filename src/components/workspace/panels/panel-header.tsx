"use client"

import * as React from "react"
import { Search } from "lucide-react"

import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

interface PanelHeaderProps {
  title: React.ReactNode
  leading?: React.ReactNode
  actions?: React.ReactNode
  hideTitle?: boolean
}

/** Shared panel chrome: a text-only section title with optional controls. */
export function PanelHeader({ title, leading, actions, hideTitle = false }: PanelHeaderProps) {
  return (
    <header
      className={cn(
        "flex h-14 shrink-0 items-center gap-2 px-4 py-4",
        hideTitle ? "justify-start" : "justify-between",
      )}
    >
      {!hideTitle && (
        <div className="flex min-w-0 items-center gap-2">
          {leading}
          <h2 className="min-w-0 truncate text-sm font-semibold">{title}</h2>
        </div>
      )}
      {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
    </header>
  )
}

interface PanelSearchProps {
  value: string
  onChange: (value: string) => void
  placeholder: string
  ariaLabel?: string
}

/** Consistent compact search field for list-oriented panels. */
export function PanelSearch({ value, onChange, placeholder, ariaLabel }: PanelSearchProps) {
  return (
    <div className="shrink-0 px-4 pb-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
        <Input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-label={ariaLabel ?? placeholder}
          placeholder={placeholder}
          className="h-8 min-w-0 bg-transparent pl-8 text-xs"
        />
      </div>
    </div>
  )
}
