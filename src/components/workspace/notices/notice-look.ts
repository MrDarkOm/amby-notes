import type * as React from "react"
import { CircleAlert, CircleCheck, Info, OctagonAlert, TriangleAlert } from "lucide-react"

/** The five levels of a notice (docs/notices.md, section 2.1). */
export type NoticeLevel = "danger" | "decision" | "warning" | "info" | "success"

/**
 * What a level looks like: the icon, the colour of the icon and the frame. The colours are the theme
 * tokens `--notice-{level}-{bg,fg,border}` (src/themes/app.css), never a palette class. Every class is
 * written out in full so that Tailwind can find it.
 */
export const NOTICE_LOOK: Record<
  NoticeLevel,
  { Icon: React.ComponentType<{ className?: string }>; icon: string; frame: string }
> = {
  danger: {
    Icon: OctagonAlert,
    icon: "text-[color:var(--notice-danger-fg)]",
    frame: "bg-[color:var(--notice-danger-bg)] border-[color:var(--notice-danger-border)]",
  },
  decision: {
    Icon: TriangleAlert,
    icon: "text-[color:var(--notice-decision-fg)]",
    frame: "bg-[color:var(--notice-decision-bg)] border-[color:var(--notice-decision-border)]",
  },
  warning: {
    Icon: CircleAlert,
    icon: "text-[color:var(--notice-warning-fg)]",
    frame: "bg-[color:var(--notice-warning-bg)] border-[color:var(--notice-warning-border)]",
  },
  info: {
    Icon: Info,
    icon: "text-[color:var(--notice-info-fg)]",
    frame: "bg-[color:var(--notice-info-bg)] border-[color:var(--notice-info-border)]",
  },
  success: {
    Icon: CircleCheck,
    icon: "text-[color:var(--notice-success-fg)]",
    frame: "bg-[color:var(--notice-success-bg)] border-[color:var(--notice-success-border)]",
  },
}

/**
 * The background and border classes of a level, for a control that is not a status region (the badge of
 * the conflicts is a button). Everything else wears `NoticeShell`.
 */
export function noticeFrameClass(level: NoticeLevel): string {
  return NOTICE_LOOK[level].frame
}
