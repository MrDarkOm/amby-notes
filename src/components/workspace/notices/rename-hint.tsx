import type * as React from "react"

import { cn } from "@/lib/utils"
import { NoticeLevelIcon, NoticeShell } from "./notice-level"

/**
 * The line under a name field that says why the name was not taken (docs/notices.md, section 8). Nothing is
 * lost, so the level is `warning`. It goes away when the name is changed or the field is closed.
 */
export function RenameHint({
  text,
  id,
  className,
  style,
}: {
  text: string
  id?: string
  className?: string
  style?: React.CSSProperties
}) {
  return (
    <NoticeShell
      level="warning"
      variant="calm"
      id={id}
      style={style}
      data-testid="rename-hint"
      className={cn(
        "flex items-start gap-1.5 rounded-md px-2 py-1 text-[11px] leading-snug text-foreground shadow-md",
        className,
      )}
    >
      <NoticeLevelIcon level="warning" className="mt-px size-3 shrink-0" />
      <span className="min-w-0">{text}</span>
    </NoticeShell>
  )
}
