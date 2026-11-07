import * as React from "react"

import { cn } from "@/lib/utils"
import { NOTICE_LOOK, noticeFrameClass, type NoticeLevel } from "./notice-look"

export type { NoticeLevel } from "./notice-look"

/** The icon that belongs to the level, in the colour of the level. Decoration: the text says the rest. */
export function NoticeLevelIcon({ level, className }: { level: NoticeLevel; className?: string }) {
  const { Icon, icon } = NOTICE_LOOK[level]
  return <Icon aria-hidden="true" className={cn(icon, className)} />
}

/**
 * The frame of a notice of any place (a card of a note, a toast, a line under an element): the role for
 * screen readers (`danger` is an alert, the rest a status), the level and the colours of the level. The
 * content and the layout are the caller's.
 */
export function NoticeShell({
  level,
  className,
  children,
  ...rest
}: {
  level: NoticeLevel
  className?: string
  children?: React.ReactNode
} & Omit<React.HTMLAttributes<HTMLDivElement>, "role" | "className" | "children">) {
  return (
    <div
      {...rest}
      role={level === "danger" ? "alert" : "status"}
      data-level={level}
      className={cn(noticeFrameClass(level), className)}
    >
      {children}
    </div>
  )
}
