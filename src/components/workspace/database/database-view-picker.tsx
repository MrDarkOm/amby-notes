"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { ArrowLeft, Check, Database, Search } from "lucide-react"
import { IconValue } from "@/components/workspace/icon-value"
import { cn } from "@/lib/utils"
import { getViewLayoutIcon } from "./database-layout-icons"
import { useDatabaseStore } from "./database-store"
import {
  choiceForOption,
  filterDatabases,
  isBindable,
  viewOptions,
  type DatabaseViewChoice,
} from "./database-view-picker-model"

interface DatabaseViewPickerProps {
  /** The view the block is bound to now; marked in the list. */
  current?: DatabaseViewChoice | null
  autoFocus?: boolean
  onSelect: (choice: DatabaseViewChoice) => void
  /** Escape in the first step. */
  onCancel?: () => void
  className?: string
}

/**
 * Picks any database of the vault (the data), then how to show it: one of its
 * saved views or a plain layout. Shared by the insert menu and by the header of
 * an existing block, so a new block and a rebind offer the same choices.
 */
export function DatabaseViewPicker({
  current,
  autoFocus = true,
  onSelect,
  onCancel,
  className,
}: DatabaseViewPickerProps) {
  const { t } = useTranslation()
  const runtime = useDatabaseStore((state) => state.runtime)
  const catalogStatus = useDatabaseStore((state) => state.catalogStatus)
  const catalogError = useDatabaseStore((state) => state.error)
  const databases = useDatabaseStore((state) => state.databases)
  const [query, setQuery] = React.useState("")
  const [active, setActive] = React.useState(0)
  const [expandedId, setExpandedId] = React.useState<string | null>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)

  const expanded = databases.find((database) => database.databaseId === expandedId) ?? null
  const filtered = React.useMemo(() => filterDatabases(databases, query), [databases, query])
  const options = React.useMemo(() => (expanded ? viewOptions(expanded) : []), [expanded])
  const itemCount = expanded ? options.length : filtered.length

  React.useEffect(() => setActive(0), [query, expandedId])
  React.useEffect(() => {
    if (!autoFocus) return
    const frame = requestAnimationFrame(() =>
      (expandedId ? listRef.current : inputRef.current)?.focus({ preventScroll: true }),
    )
    return () => cancelAnimationFrame(frame)
  }, [autoFocus, expandedId])

  function chooseIndex(index: number) {
    if (expanded) {
      const option = options[index]
      const choice = option && choiceForOption(expanded, option)
      if (choice) onSelect(choice)
      return
    }
    const database = filtered[index]
    if (!database || !isBindable(database)) return
    setExpandedId(database.databaseId)
    setQuery("")
  }

  function onKeyDown(event: React.KeyboardEvent) {
    // Keep the editor (ProseMirror, slash plugin) out of the picker's keys.
    event.stopPropagation()
    if (event.key === "ArrowDown") {
      event.preventDefault()
      if (itemCount > 0) setActive((index) => Math.min(index + 1, itemCount - 1))
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setActive((index) => Math.max(index - 1, 0))
    } else if (event.key === "Enter") {
      event.preventDefault()
      chooseIndex(active)
    } else if (event.key === "Escape") {
      event.preventDefault()
      if (expanded) setExpandedId(null)
      else onCancel?.()
    }
  }

  const unavailable = !runtime?.enabled || catalogStatus === "disabled"
  const loading = !unavailable && (catalogStatus === "idle" || catalogStatus === "loading")

  return (
    <div className={cn("flex min-h-0 flex-col", className)} data-testid="database-view-picker">
      <div className="flex items-center gap-2 border-b border-border/80 bg-muted/20 px-3 py-2">
        {expanded ? (
          <button
            type="button"
            className="rounded p-0.5 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            aria-label={t("databasePicker.back")}
            title={t("databasePicker.back")}
            onClick={() => setExpandedId(null)}
          >
            <ArrowLeft className="size-4" />
          </button>
        ) : (
          <Search className="size-4 shrink-0 text-muted-foreground" />
        )}
        {expanded ? (
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{expanded.title}</span>
        ) : (
          <input
            ref={inputRef}
            type="text"
            value={query}
            disabled={unavailable}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            onMouseDown={(event) => event.stopPropagation()}
            placeholder={t("databasePicker.search")}
            aria-label={t("databasePicker.search")}
            className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground sm:text-sm"
          />
        )}
      </div>
      <div
        role="listbox"
        aria-label={t("databasePicker.listLabel")}
        tabIndex={expanded ? 0 : -1}
        ref={listRef}
        onKeyDown={expanded ? onKeyDown : undefined}
        className="max-h-[260px] min-h-[96px] flex-1 overflow-y-auto py-1 outline-none"
      >
        {unavailable ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            {t("databasePicker.unavailable")}
          </p>
        ) : loading ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            {t("common.loading")}
          </p>
        ) : catalogStatus === "error" ? (
          <p role="alert" className="px-3 py-6 text-center text-xs text-destructive">
            {t("databasePicker.error")}
            {catalogError && (
              <span className="mt-1 block text-[11px] text-muted-foreground">{catalogError}</span>
            )}
          </p>
        ) : expanded ? (
          options.map((option, index) => {
            const first = index === 0 || options[index - 1].kind !== option.kind
            const layout = option.kind === "view" ? option.view.layout : option.layout
            const Icon = getViewLayoutIcon(layout)
            const selected =
              option.kind === "view"
                ? current?.databaseId === expanded.databaseId &&
                  current.viewId === option.view.viewId &&
                  !current.layout
                : current?.databaseId === expanded.databaseId && current.layout === option.layout
            return (
              <React.Fragment key={option.kind === "view" ? option.view.viewId : option.layout}>
                {first && (
                  <p className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {option.kind === "view"
                      ? t("databasePicker.savedViews")
                      : t("databasePicker.showAs")}
                  </p>
                )}
                <PickerRow
                  active={active === index}
                  selected={selected}
                  icon={<Icon className="size-4 shrink-0 text-muted-foreground" />}
                  label={
                    option.kind === "view" ? option.view.title : t(`databaseLayouts.${layout}`)
                  }
                  hint={option.kind === "view" ? t(`databaseLayouts.${layout}`) : ""}
                  onHover={() => setActive(index)}
                  onChoose={() => chooseIndex(index)}
                />
              </React.Fragment>
            )
          })
        ) : filtered.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            {databases.length === 0 ? t("databasePicker.noDatabases") : t("databasePicker.noMatch")}
          </p>
        ) : (
          filtered.map((database, index) => (
            <PickerRow
              key={database.databaseId}
              active={active === index}
              selected={current?.databaseId === database.databaseId}
              disabled={!isBindable(database)}
              icon={
                <IconValue
                  value={database.icon ?? undefined}
                  fallback={<Database className="size-4 text-muted-foreground" />}
                  className="size-4 shrink-0"
                />
              }
              label={database.title}
              hint={
                isBindable(database)
                  ? t("databasePicker.viewCount", { count: database.views.length })
                  : t("databasePicker.noViews")
              }
              onHover={() => setActive(index)}
              onChoose={() => chooseIndex(index)}
            />
          ))
        )}
      </div>
    </div>
  )
}

function PickerRow({
  active,
  selected,
  disabled = false,
  icon,
  label,
  hint,
  onHover,
  onChoose,
}: {
  active: boolean
  selected: boolean
  disabled?: boolean
  icon: React.ReactNode
  label: string
  hint: string
  onHover: () => void
  onChoose: () => void
}) {
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      className={cn(
        "mx-1 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs",
        active && "bg-accent/60",
        disabled && "cursor-not-allowed opacity-50",
      )}
      onMouseEnter={onHover}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => !disabled && onChoose()}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-[11px] text-muted-foreground">{hint}</span>
      {selected && <Check className="size-3.5 shrink-0 text-muted-foreground" />}
    </div>
  )
}
