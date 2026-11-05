import * as React from "react"

export interface Notice {
  /** Stable while the same thing is being said; a new one opens the stack when it is urgent. */
  id: string
  /** The text of the note is in danger, or the person must decide: opens the stack by itself. */
  urgent: boolean
  card: React.ReactNode
}

export function Card({
  testId,
  urgent,
  icon,
  title,
  lines = [],
  error,
  actions,
}: {
  testId: string
  urgent: boolean
  icon: React.ReactNode
  title: string
  lines?: string[]
  error?: string | null
  actions?: React.ReactNode
}) {
  return (
    <div
      data-testid={testId}
      data-urgent={urgent}
      className="note-notice-card pointer-events-auto flex items-start gap-3 px-3 py-2.5"
    >
      <span className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-300">{icon}</span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-[13px] font-medium">{title}</p>
        {lines.map((line) => (
          <p key={line} className="break-all text-[11px] text-muted-foreground">
            {line}
          </p>
        ))}
        {error && (
          <p role="alert" className="text-[11px] text-destructive">
            {error}
          </p>
        )}
        {actions && <div className="flex flex-wrap gap-2 pt-1">{actions}</div>}
      </div>
    </div>
  )
}
