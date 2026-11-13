import * as React from "react"
import { useTranslation } from "react-i18next"
import { X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { NoticeLevelIcon, NoticeShell } from "./notice-level"
import { requestOpenNote } from "./note-open-request"
import { useBellAnchor } from "./use-bell-anchor"
import { useNoticeToastStore, type NoticeToast } from "./use-notice-toasts-store"
import { useNoticesStackStore } from "./use-notices-stack-store"

/** How long a toast stays, in milliseconds (docs/notices.md, section 6). */
export const TOAST_MS = 10_000

/** The most toasts seen at once; the rest are folded into "N more". */
const MAX_VISIBLE = 3

/**
 * One toast: the same calm card as in the stack. It has a time of its own that starts when it is seen (a toast
 * that waits in "N more" has not started), stops while the pointer or the focus is on it, and goes on with what
 * was left. A click on it opens the stack, where the notice stands; the short button, when there is one, goes
 * to the note instead.
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

  const openStack = () => useNoticesStackStore.getState().open()

  return (
    <NoticeShell
      level={toast.level}
      variant="calm"
      data-testid="notice-toast"
      data-toast-id={toast.id}
      tabIndex={0}
      onClick={openStack}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          openStack()
        }
      }}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
      className="pointer-events-auto flex cursor-pointer items-start gap-2 rounded-lg px-3 py-2 text-[12px] text-foreground shadow-lg"
    >
      <NoticeLevelIcon level={toast.level} className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p>{t(toast.titleKey, { ...toast.params, count: toast.count })}</p>
        {toast.actionKey && toast.target.kind === "note" && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={(event) => {
              event.stopPropagation()
              dismiss(toast.id)
              if (toast.target.kind === "note") requestOpenNote({ id: toast.target.id })
            }}
          >
            {t(toast.actionKey)}
          </Button>
        )}
      </div>
      <button
        type="button"
        aria-label={t("common.close")}
        className="shrink-0 text-muted-foreground hover:text-foreground"
        onClick={(event) => {
          event.stopPropagation()
          dismiss(toast.id)
        }}
      >
        <X className="size-3.5" />
      </button>
    </NoticeShell>
  )
}

/**
 * The announcements of danger and decisions, beside the bell of the dock where the stack of the centre grows
 * from (docs/notices.md, section 6). Three at most; the rest are "N more", which opens the stack. While the
 * stack is open there are none.
 */
export function NoticeToastHost() {
  const { t } = useTranslation()
  const toasts = useNoticeToastStore((state) => state.toasts)
  const stackOpen = useNoticesStackStore((state) => state.isOpen)
  const anchor = useBellAnchor(toasts.length > 0)
  const shown = stackOpen ? [] : toasts.slice(0, MAX_VISIBLE)
  const hidden = stackOpen ? 0 : toasts.length - shown.length
  return (
    <div
      data-testid="notice-toasts"
      style={anchor}
      className="pointer-events-none fixed z-50 flex w-[min(22rem,calc(100vw-4rem))] flex-col items-stretch gap-2"
    >
      {shown.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
      {hidden > 0 && (
        <button
          type="button"
          data-testid="notice-toasts-more"
          className="pointer-events-auto self-start rounded-md border border-border bg-popover px-2 py-1 text-[11px] text-muted-foreground shadow-sm hover:text-foreground"
          onClick={() => useNoticesStackStore.getState().open()}
        >
          {t("notices.toast.more", { count: hidden })}
        </button>
      )}
    </div>
  )
}
