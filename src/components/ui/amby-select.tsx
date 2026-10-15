"use client"

import * as React from "react"
import { Check, ChevronDown } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

export interface AmbySelectOption {
  value: string
  label: string
  /** A second, muted line under the label. */
  hint?: string
  disabled?: boolean
  /** Options with the same group are listed under its heading. */
  group?: string
}

/** A last item that runs an action instead of choosing a value ("New story"). */
export interface AmbySelectAction {
  label: string
  icon?: React.ReactNode
  onSelect: () => void
}

interface AmbySelectProps {
  value: string
  onValueChange: (value: string) => void
  options: AmbySelectOption[]
  disabled?: boolean
  /** Shown while the value matches no option. */
  placeholder?: string
  "aria-label"?: string
  title?: string
  id?: string
  /** `bare` is borderless until hovered, for lists inside tables and rows. */
  variant?: "field" | "bare"
  size?: "sm" | "md"
  className?: string
  /** Extra classes of the list itself. */
  listClassName?: string
  /** Extra classes of the arrow, for a control that shows it only while hovered. */
  chevronClassName?: string
  /** What the closed control shows for the active choice, instead of its label. */
  renderValue?: (active: AmbySelectOption | undefined) => React.ReactNode
  /** A last, separate item of the list that acts instead of choosing. */
  action?: AmbySelectAction
}

/**
 * The app's own drop-down list, in place of the system one: it follows the theme, opens in an
 * animated popover, and always lists the active choice first (checked), the rest below it.
 * Arrow keys move through the list, Enter or Space picks, Escape closes.
 */
export function AmbySelect({
  value,
  onValueChange,
  options,
  disabled,
  placeholder,
  title,
  id,
  variant = "field",
  size = "md",
  className,
  listClassName,
  chevronClassName,
  renderValue,
  action,
  ...rest
}: AmbySelectProps) {
  const [open, setOpen] = React.useState(false)
  const listRef = React.useRef<HTMLDivElement>(null)
  const active = options.find((option) => option.value === value)
  const others = options.filter((option) => option !== active)
  const groups = Array.from(new Set(others.map((option) => option.group ?? "")))

  const pick = (next: string) => {
    setOpen(false)
    if (next !== value) onValueChange(next)
  }
  const move = (from: HTMLElement | null, step: 1 | -1 | "first" | "last") => {
    const items = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? [],
    )
    if (items.length === 0) return
    const index = from ? items.indexOf(from as HTMLButtonElement) : -1
    const next =
      step === "first"
        ? 0
        : step === "last"
          ? items.length - 1
          : (index + step + items.length) % items.length
    items[next]?.focus()
  }

  const renderOption = (option: AmbySelectOption, isActive: boolean) => (
    <button
      key={option.value}
      type="button"
      role="option"
      aria-selected={isActive}
      disabled={option.disabled}
      tabIndex={-1}
      onClick={() => pick(option.value)}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] outline-none focus-visible:bg-accent hover:bg-accent disabled:pointer-events-none disabled:opacity-50",
        isActive && "bg-primary/10 font-medium",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate">{option.label}</span>
        {option.hint && (
          <span className="block truncate text-[11px] font-normal text-muted-foreground">
            {option.hint}
          </span>
        )}
      </span>
      {isActive && <Check className="size-4 shrink-0 text-primary" />}
    </button>
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          id={id}
          aria-label={rest["aria-label"]}
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={disabled}
          title={title ?? active?.label}
          className={cn(
            "flex w-full min-w-0 items-center justify-between gap-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60",
            size === "sm" ? "h-7 text-xs" : "h-8 text-[13px]",
            variant === "field"
              ? "rounded-lg border border-input bg-background px-2.5 hover:border-foreground/30"
              : "rounded-md bg-transparent px-1.5 hover:bg-accent/50",
            className,
          )}
          onClick={(event) => event.stopPropagation()}
          // The list is a layer of its own: keys typed here must not drive a menu around it.
          onKeyDown={(event) => {
            if (event.key !== "Tab" && event.key !== "Escape") event.stopPropagation()
          }}
        >
          {renderValue ? (
            <span className="flex min-w-0 flex-1 items-center">{renderValue(active)}</span>
          ) : (
            <span className={cn("min-w-0 flex-1 truncate", !active && "text-muted-foreground")}>
              {active?.label ?? placeholder ?? ""}
            </span>
          )}
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground",
              open && "rotate-180",
              chevronClassName,
            )}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className={cn("w-auto max-w-[min(24rem,90vw)] rounded-xl p-1 shadow-md", listClassName)}
        style={{ minWidth: "max(var(--radix-popover-trigger-width), 9rem)" }}
        onOpenAutoFocus={(event) => {
          // Focus goes to the active choice, which is the first in the list.
          event.preventDefault()
          move(null, "first")
        }}
        onKeyDown={(event) => {
          // Escape and Tab belong to the popover; every other key stays inside the list.
          if (event.key === "Escape" || event.key === "Tab") return
          event.stopPropagation()
          const current = document.activeElement as HTMLElement | null
          if (event.key === "ArrowDown") move(current, 1)
          else if (event.key === "ArrowUp") move(current, -1)
          else if (event.key === "Home") move(current, "first")
          else if (event.key === "End") move(current, "last")
          else return
          event.preventDefault()
        }}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div
          ref={listRef}
          role="listbox"
          aria-label={rest["aria-label"]}
          className="max-h-64 overflow-y-auto"
        >
          {active && renderOption(active, true)}
          {active && others.length > 0 && <div className="mx-1 my-1 border-t border-border/60" />}
          {groups.map((group) => (
            <div key={group || "ungrouped"}>
              {group && (
                <div className="px-2 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {group}
                </div>
              )}
              {others
                .filter((option) => (option.group ?? "") === group)
                .map((option) => renderOption(option, false))}
            </div>
          ))}
          {options.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">—</p>}
          {action && (
            <>
              <div className="mx-1 my-1 border-t border-border/60" />
              <button
                type="button"
                role="option"
                aria-selected={false}
                tabIndex={-1}
                onClick={() => {
                  setOpen(false)
                  action.onSelect()
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] outline-none hover:bg-accent focus-visible:bg-accent"
              >
                {action.icon && (
                  <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                    {action.icon}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">{action.label}</span>
              </button>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
