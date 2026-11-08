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
  {
    Icon: React.ComponentType<{ className?: string }>
    icon: string
    frame: string
    dot: string
    stripe: string
  }
> = {
  danger: {
    Icon: OctagonAlert,
    icon: "text-[color:var(--notice-danger-fg)]",
    frame: "bg-[color:var(--notice-danger-bg)] border-[color:var(--notice-danger-border)]",
    dot: "bg-[color:var(--notice-danger-fg)]",
    stripe: "border-l-[color:var(--notice-danger-fg)]",
  },
  decision: {
    Icon: TriangleAlert,
    icon: "text-[color:var(--notice-decision-fg)]",
    frame: "bg-[color:var(--notice-decision-bg)] border-[color:var(--notice-decision-border)]",
    dot: "bg-[color:var(--notice-decision-fg)]",
    stripe: "border-l-[color:var(--notice-decision-fg)]",
  },
  warning: {
    Icon: CircleAlert,
    icon: "text-[color:var(--notice-warning-fg)]",
    frame: "bg-[color:var(--notice-warning-bg)] border-[color:var(--notice-warning-border)]",
    dot: "bg-[color:var(--notice-warning-fg)]",
    stripe: "border-l-[color:var(--notice-warning-fg)]",
  },
  info: {
    Icon: Info,
    icon: "text-[color:var(--notice-info-fg)]",
    frame: "bg-[color:var(--notice-info-bg)] border-[color:var(--notice-info-border)]",
    dot: "bg-[color:var(--notice-info-fg)]",
    stripe: "border-l-[color:var(--notice-info-fg)]",
  },
  success: {
    Icon: CircleCheck,
    icon: "text-[color:var(--notice-success-fg)]",
    frame: "bg-[color:var(--notice-success-bg)] border-[color:var(--notice-success-border)]",
    dot: "bg-[color:var(--notice-success-fg)]",
    stripe: "border-l-[color:var(--notice-success-fg)]",
  },
}

/**
 * The background and border classes of a level, for a control that is not a status region (the badge of
 * the conflicts is a button). Everything else wears `NoticeShell`.
 */
export function noticeFrameClass(level: NoticeLevel): string {
  return NOTICE_LOOK[level].frame
}

/**
 * The calm look of a card (docs/notices.md, section 11): an ordinary surface with a thin neutral frame and a stripe
 * of the colour of the level on the left. No fill and no coloured frame; the level is said by the stripe and
 * the icon. The one place that says it, for the cards of the stack, the toasts and the lines of the journal.
 */
export function noticeCalmClass(level: NoticeLevel): string {
  return `border border-border/70 bg-card border-l-[3px] ${NOTICE_LOOK[level].stripe}`
}

/**
 * Whether a notice of this level opens the stack of a note by itself: only a danger and a decision do
 * (docs/notices.md, sections 2.1 and 7). The one place that says it.
 */
export function noticeIsUrgent(level: NoticeLevel): boolean {
  return level === "danger" || level === "decision"
}

const BY_SERIOUSNESS = ["danger", "decision", "warning", "info", "success"] as const

/** Where a level stands in the order of seriousness: 0 is the most serious. */
export function noticeSeverityRank(level: NoticeLevel): number {
  return BY_SERIOUSNESS.indexOf(level)
}

/** The most serious of the levels, or null when there are none (docs/notices.md, section 2.1 order). */
export function mostSeriousNoticeLevel(levels: readonly NoticeLevel[]): NoticeLevel | null {
  return BY_SERIOUSNESS.find((level) => levels.includes(level)) ?? null
}

/** The classes of a small number badge of a level: its background, border and text colours. */
export function noticeBadgeClass(level: NoticeLevel): string {
  const { icon, frame } = NOTICE_LOOK[level]
  return `${frame} ${icon}`
}

/** The classes of the small dot of a level (the colour of its text, as a fill). */
export function noticeDotClass(level: NoticeLevel): string {
  return NOTICE_LOOK[level].dot
}
