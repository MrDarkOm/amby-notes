import * as React from "react"

import { NoticeLevelIcon, NoticeShell, type NoticeLevel } from "../notices/notice-level"

export interface Notice {
  /** Stable while the same thing is being said; a new one opens the stack when it is urgent. */
  id: string
  /** The text of the note is in danger, or the person must decide: opens the stack by itself. */
  urgent: boolean
  card: React.ReactNode
}

/**
 * One card of the stack. The level (docs/notices.md, section 2.1) gives its icon, role and colours; `urgent`
 * is a separate matter: whether the card opens the stack by itself.
 */
export function Card({
  testId,
  level,
  urgent,
  title,
  lines = [],
  error,
  actions,
}: {
  testId: string
  level: NoticeLevel
  urgent: boolean
  title: string
  lines?: string[]
  error?: string | null
  actions?: React.ReactNode
}) {
  return (
    <NoticeShell
      level={level}
      data-testid={testId}
      data-urgent={urgent}
      className="note-notice-card pointer-events-auto flex items-start gap-3 border-l-2 px-3 py-2.5"
    >
      <NoticeLevelIcon level={level} className="mt-0.5 size-4 shrink-0" />
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
    </NoticeShell>
  )
}
