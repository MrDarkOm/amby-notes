import { cn } from "@/lib/utils"
import { NoticeLevelIcon, NoticeShell, type NoticeLevel } from "./notice-level"
import { noticeTextClass } from "./notice-look"

/**
 * The line under an element that says why the action on it was not taken (docs/notices.md, section 8): a
 * property editor, a cell, a menu. Nothing is lost, so the usual level is `warning`. The text is from the
 * dictionary by the code of the error; the colour is the token of the level, not red.
 */
export function NoticeLine({
  text,
  level = "warning",
  className,
  id,
}: {
  text: string
  level?: NoticeLevel
  className?: string
  id?: string
}) {
  return (
    <NoticeShell
      level={level}
      variant="plain"
      id={id}
      data-testid="notice-line"
      className={cn(
        "flex items-start gap-1.5 text-xs leading-snug",
        noticeTextClass(level),
        className,
      )}
    >
      <NoticeLevelIcon level={level} className="mt-px size-3 shrink-0" />
      <span className="min-w-0 break-words">{text}</span>
    </NoticeShell>
  )
}
