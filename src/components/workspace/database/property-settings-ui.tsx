import * as React from "react"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"

/** A labelled group of one setting. */
export function SettingField({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <div className="px-0.5 text-[11px] font-medium text-muted-foreground">{label}</div>
      {children}
      {hint && <p className="px-0.5 text-[11px] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** One of a few choices, as a row of pills. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string
  value: T
  options: { id: T; label: string }[]
  disabled?: boolean
  onChange: (value: T) => void
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-lg bg-muted/60 p-0.5">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          disabled={disabled}
          onClick={() => onChange(option.id)}
          className={cn(
            "min-w-0 flex-1 truncate rounded-md px-2 py-1 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50",
            value === option.id
              ? "bg-background font-medium shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** A setting that is on or off, with a short explanation under it. */
export function SettingToggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string
  hint?: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg px-0.5">
      <div className="min-w-0">
        <div className="text-[13px]">{label}</div>
        {hint && <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>}
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        aria-label={label}
        className="mt-0.5"
        onCheckedChange={onChange}
      />
    </div>
  )
}

/** A setting on one line: icon and name on the left, its control on the right. */
export function SettingInlineRow({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-9 items-center gap-2.5 px-1">
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px]" title={label}>
        {label}
      </span>
      <div className="w-[50%] shrink-0">{children}</div>
    </div>
  )
}
