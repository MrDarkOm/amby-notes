import * as React from "react"
import { Check, ChevronRight } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"

/** A settings row: icon, label, current value, and a chevron when it opens a page. */
export function Row({
  icon,
  label,
  value,
  onClick,
  disabled,
  chevron,
  trailing,
  danger,
}: {
  /** Without an icon the row starts at the label (the pages of a grouped board). */
  icon?: React.ReactNode
  label: string
  value?: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  chevron?: boolean
  trailing?: React.ReactNode
  danger?: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        danger && "text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10",
      )}
    >
      {icon !== undefined && (
        <span
          className={cn(
            "flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4",
            danger && "text-destructive",
          )}
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {value !== undefined && (
        <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">{value}</span>
      )}
      {trailing}
      {chevron && <ChevronRight className="size-4 shrink-0 text-muted-foreground/70" />}
    </button>
  )
}

/** A group of rows; a divider line separates it from the group above. */
export function Section({ divider, children }: { divider?: boolean; children: React.ReactNode }) {
  return (
    <section
      className={cn("space-y-0.5 pb-1.5", divider && "mt-0.5 border-t border-border/60 pt-1.5")}
    >
      {children}
    </section>
  )
}

/** A choice in a list page: a label, an optional description and a check on the chosen one. */
export function ChoiceRow({
  label,
  description,
  selected,
  disabled,
  onClick,
}: {
  label: string
  description?: string
  selected: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        selected && "bg-primary/10",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px]">{label}</span>
        {description && (
          <span className="block text-xs leading-snug text-muted-foreground">{description}</span>
        )}
      </span>
      {selected && <Check className="size-4 shrink-0 text-primary" />}
    </button>
  )
}

/** A property with an on/off switch. */
export function SwitchRow({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div className="flex h-8 items-center gap-2.5 rounded-lg px-2.5 hover:bg-accent">
      <span className="min-w-0 flex-1 truncate text-[13px]">{label}</span>
      <Switch checked={checked} disabled={disabled} aria-label={label} onCheckedChange={onChange} />
    </div>
  )
}
