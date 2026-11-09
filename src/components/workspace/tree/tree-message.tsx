import { useTranslation } from "react-i18next"
import { X } from "lucide-react"

import { NoticeLevelIcon, NoticeShell } from "../notices/notice-level"
import { useTreeMessageStore } from "./use-tree-message-store"

/**
 * The line under the tree: what became of the last move, deletion or drop of files (docs/notices.md, section 8).
 * It stays until the person closes it or the next answer replaces it.
 */
export function TreeMessage() {
  const { t } = useTranslation()
  const message = useTreeMessageStore((state) => state.message)
  const dismiss = useTreeMessageStore((state) => state.dismiss)
  if (!message) return null
  return (
    <NoticeShell
      level={message.level}
      variant="calm"
      data-testid="tree-message"
      className="absolute inset-x-1.5 bottom-1.5 z-10 flex items-start gap-2 rounded-lg px-2.5 py-2 text-foreground shadow-md"
    >
      <NoticeLevelIcon level={message.level} className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1 text-[12px]">
        <p className="font-medium whitespace-pre-line">{t(message.titleKey, message.params)}</p>
        {message.lineKey && <p className="text-muted-foreground">{t(message.lineKey)}</p>}
        {message.action && (
          <button
            type="button"
            className="mt-1 rounded border border-border px-2 py-0.5 text-[12px] hover:bg-accent"
            onClick={() => {
              const { run } = message.action!
              dismiss()
              void run()
            }}
          >
            {t(message.action.labelKey)}
          </button>
        )}
      </div>
      <button
        type="button"
        aria-label={t("common.close")}
        onClick={dismiss}
        className="text-muted-foreground hover:text-foreground -mr-1 rounded p-0.5"
      >
        <X className="size-3.5" />
      </button>
    </NoticeShell>
  )
}
