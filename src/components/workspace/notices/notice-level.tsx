import * as React from "react"

/** The five levels of a notice (docs/notices.md, section 2.1). */
export type NoticeLevel = "danger" | "decision" | "warning" | "info" | "success"

/** The icon that belongs to the level (docs/notices.md, section 11). Interface only: no drawing yet. */
export function NoticeLevelIcon(_props: { level: NoticeLevel; className?: string }) {
  return null
}

/** The frame of a notice: the role, the level and the colours of the level. Interface only. */
export function NoticeShell({
  children,
  className,
  ...rest
}: {
  level: NoticeLevel
  className?: string
  children?: React.ReactNode
} & Omit<React.HTMLAttributes<HTMLDivElement>, "role" | "className" | "children">) {
  return (
    <div className={className} {...rest}>
      {children}
    </div>
  )
}
