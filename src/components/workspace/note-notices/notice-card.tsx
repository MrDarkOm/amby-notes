import * as React from "react"

import { NoticeLevelIcon, NoticeShell, type NoticeLevel } from "../notices/notice-level"
import { noticeIsUrgent } from "../notices/notice-look"

export interface Notice {
  /** Stable while the same thing is being said; a new urgent one opens the stack. */
  id: string
  /**
   * The card; its `level` is the level of the notice. A danger or a decision (and only these) opens the
   * stack by itself.
   */
  card: React.ReactElement<CardProps>
}

/**
 * One card of the stack. The level (docs/notices.md, section 2.1) gives its icon, role and colours, and
 * whether it opens the stack by itself (`data-urgent`).
 */
export interface CardProps {
  testId: string
  level: NoticeLevel
  title: string
  lines?: string[]
  error?: string | null
  actions?: React.ReactNode
}

export function Card({ testId, level, title, lines = [], error, actions }: CardProps) {
  return (
    <NoticeShell
      level={level}
      data-testid={testId}
      data-urgent={noticeIsUrgent(level)}
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
