import * as React from "react"
import { useTranslation } from "react-i18next"
import { X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { requestOpenPanel } from "../panel-navigation"
import { NoticeLevelIcon, NoticeShell } from "./notice-level"
import { requestOpenNote } from "./note-open-request"
import { useNoticeToastStore, type NoticeToast, type ToastTarget } from "./use-notice-toasts-store"

/** How long a toast stays, in milliseconds (docs/notices.md, section 6). */
export const TOAST_MS = 10_000

/** The most toasts seen at once; the rest are folded into "N more". */
const MAX_VISIBLE = 3

/** The id of the panel of the notification centre. */
export const CENTRE_PANEL_ID = "notices-centre"

function goTo(target: ToastTarget): void {
  if (target.kind === "centre") requestOpenPanel(CENTRE_PANEL_ID)
  else requestOpenNote({ id: target.id })
}

/**
 * One toast. It has a time of its own that starts when it is seen (a toast that waits in "N more" has not
 * started), stops while the pointer or the focus is on it, and goes on with what was left.
 */
function ToastCard({ toast }: { toast: NoticeToast }) {
  const { t } = useTranslation()
  const dismiss = useNoticeToastStore((state) => state.dismiss)
  const [held, setHeld] = React.useState(false)
  const left = React.useRef(TOAST_MS)
  const startedAt = React.useRef(0)

  // The same cause announced again is news again: the whole time starts anew.
  React.useEffect(() => {
    left.current = TOAST_MS
  }, [toast.serial])

  React.useEffect(() => {
    if (held) return
    startedAt.current = Date.now()
    const timer = window.setTimeout(() => dismiss(toast.id), left.current)
    return () => {
      window.clearTimeout(timer)
      left.current = Math.max(0, left.current - (Date.now() - startedAt.current))
    }
  }, [held, toast.id, toast.serial, dismiss])

  return (
    <NoticeShell
      level={toast.level}
      data-testid="notice-toast"
      data-toast-id={toast.id}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
      className="pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px] text-foreground shadow-lg"
    >
      <NoticeLevelIcon level={toast.level} className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p>{t(toast.titleKey, { ...toast.params, count: toast.count })}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            dismiss(toast.id)
            goTo(toast.target)
          }}
        >
          {t(toast.actionKey)}
        </Button>
      </div>
      <button
        type="button"
        aria-label={t("common.close")}
        className="shrink-0 text-muted-foreground hover:text-foreground"
        onClick={() => dismiss(toast.id)}
      >
        <X className="size-3.5" />
      </button>
    </NoticeShell>
  )
}

/**
 * The announcements of danger and decisions, in the top right corner of the workspace, away from the strip
 * of the notices of a note at the bottom. Three at most; the rest are "N more", which leads to the centre.
 */
export function NoticeToastHost() {
  const { t } = useTranslation()
  const toasts = useNoticeToastStore((state) => state.toasts)
  const shown = toasts.slice(0, MAX_VISIBLE)
  const hidden = toasts.length - shown.length
  return (
    <div
      data-testid="notice-toasts"
      className="pointer-events-none fixed right-3 top-12 z-50 flex w-[min(22rem,calc(100vw-1.5rem))] flex-col items-stretch gap-2"
    >
      {shown.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
      {hidden > 0 && (
        <button
          type="button"
          data-testid="notice-toasts-more"
          className="pointer-events-auto self-end rounded-md border border-border bg-popover px-2 py-1 text-[11px] text-muted-foreground shadow-sm hover:text-foreground"
          onClick={() => goTo({ kind: "centre" })}
        >
          {t("notices.toast.more", { count: hidden })}
        </button>
      )}
    </div>
  )
}
