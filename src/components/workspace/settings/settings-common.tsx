import * as React from "react"

export function Row({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="settings-row flex items-center justify-between gap-4 px-4">
      <div className="min-w-0">
        <div className="text-[13px] text-foreground">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export const selectTrigger = "h-8 w-44 bg-card border-border text-[13px] text-foreground"

export function SettingsIntro({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      <p className="mt-1 max-w-2xl text-[12px] leading-5 text-muted-foreground">{description}</p>
    </div>
  )
}

export function SettingsGroup({
  title,
  icon: Icon,
  children,
}: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
}) {
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
        <Icon className="size-4" />
        {title}
      </h3>
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card/30">
        {children}
      </div>
    </section>
  )
}
