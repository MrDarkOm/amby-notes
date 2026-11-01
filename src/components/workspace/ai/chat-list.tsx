import * as React from "react"
import { Check, Pencil, Trash2, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"
import { PanelSearch } from "../panels/panel-header"
import { useClipped } from "@/lib/use-clipped"
import { useAiChatStore } from "./use-ai-chat-store"
import type { ChatEntry } from "@/lib/storage"

function group(entry: ChatEntry): "today" | "yesterday" | "earlier" {
  if (!entry.updatedAt) return "earlier"
  const date = new Date(entry.updatedAt)
  if (Number.isNaN(date.valueOf())) return "earlier"
  const now = new Date()
  if (date.toDateString() === now.toDateString()) return "today"
  now.setDate(now.getDate() - 1)
  return date.toDateString() === now.toDateString() ? "yesterday" : "earlier"
}

/** When a chat was last used: the time for today's chats, the date for the rest. */
function stamp(entry: ChatEntry, language: string): string {
  if (!entry.updatedAt) return ""
  const date = new Date(entry.updatedAt)
  if (Number.isNaN(date.valueOf())) return ""
  return group(entry) === "today"
    ? new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit" }).format(date)
    : new Intl.DateTimeFormat(language, { day: "numeric", month: "short" }).format(date)
}

/** A chat's title: truncated to the row, with the whole title as a tooltip only when it is cut. */
function ChatTitle({ children, title }: { children: React.ReactNode; title: string }) {
  const [ref, clipped] = useClipped<HTMLSpanElement>(title)
  return (
    <span
      ref={ref}
      data-amby-tooltip={clipped ? title : undefined}
      className="min-w-0 flex-1 truncate"
    >
      {children}
    </span>
  )
}

export function ChatList({ onOpen }: { onOpen: () => void }) {
  const { t, i18n } = useTranslation()
  const currentId = useAiChatStore((state) => state.chat?.id)
  const entries = useAiChatStore((state) => state.entries)
  const error = useAiChatStore((state) => state.error)
  const open = useAiChatStore((state) => state.open)
  const remove = useAiChatStore((state) => state.remove)
  const [query, setQuery] = React.useState("")
  const [editing, setEditing] = React.useState<string | null>(null)
  const [title, setTitle] = React.useState("")
  const filtered = entries.filter((entry) =>
    (entry.title ?? "").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  )

  async function rename(entry: ChatEntry) {
    const nextTitle = title.trim()
    if (!nextTitle) return
    await open(entry.id)
    const state = useAiChatStore.getState()
    if (state.chat?.id !== entry.id) return
    const chat = { ...state.chat, title: nextTitle, updatedAt: new Date().toISOString() }
    state.replace(chat)
    try {
      await state.save(chat)
      setEditing(null)
    } catch {
      /* the store exposes the error */
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelSearch
        value={query}
        onChange={setQuery}
        placeholder={t("ai.searchChats")}
        ariaLabel={t("ai.searchChats")}
      />
      <ScrollArea className="min-h-0 flex-1 [&_[data-radix-scroll-area-viewport]>div]:!block">
        <div className="space-y-3 px-3 pb-3">
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {t("ai.chatSaveFailed")}
            </p>
          )}
          {filtered.length === 0 && (
            <p className="text-xs text-muted-foreground">{t("ai.noChats")}</p>
          )}
          {(["today", "yesterday", "earlier"] as const).map((section) => {
            const rows = filtered.filter((entry) => group(entry) === section)
            if (!rows.length) return null
            return (
              <section key={section}>
                <h3 className="mb-1 px-1 text-xs font-medium text-muted-foreground">
                  {t(`ai.${section}`)}
                </h3>
                {rows.map((entry) => (
                  <div
                    key={entry.id}
                    data-chat-row
                    aria-current={entry.id === currentId ? "true" : undefined}
                    className={cn(
                      "group/row relative flex items-center gap-1 rounded-lg px-1 hover:bg-accent",
                      entry.id === currentId && "bg-accent/60",
                    )}
                  >
                    {editing === entry.id ? (
                      <>
                        <input
                          autoFocus
                          value={title}
                          onChange={(event) => setTitle(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void rename(entry)
                            if (event.key === "Escape") setEditing(null)
                          }}
                          className="min-w-0 flex-1 rounded border border-border bg-card px-1 text-sm"
                        />
                        <button
                          type="button"
                          title={t("ai.saveName")}
                          aria-label={t("ai.saveName")}
                          onClick={() => void rename(entry)}
                        >
                          <Check className="size-4" />
                        </button>
                        <button
                          type="button"
                          title={t("ai.cancelRename")}
                          aria-label={t("ai.cancelRename")}
                          onClick={() => setEditing(null)}
                        >
                          <X className="size-4" />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-2 p-1.5 text-left text-sm"
                          onClick={() => {
                            void open(entry.id).then(onOpen)
                          }}
                        >
                          <ChatTitle title={entry.title ?? ""}>
                            {entry.title ||
                              t(
                                entry.status === "corrupt"
                                  ? "ai.chatUnavailable"
                                  : "ai.unnamedChat",
                              )}
                            {entry.status !== "ready" && (
                              <span className="ml-1 text-[10px] text-muted-foreground">
                                {t(
                                  entry.status === "corrupt"
                                    ? "ai.chatUnavailable"
                                    : "ai.chatReadOnly",
                                )}
                              </span>
                            )}
                          </ChatTitle>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {stamp(entry, i18n.language)}
                          </span>
                        </button>
                        <div className="pointer-events-none absolute inset-y-0 right-1 flex items-center gap-0.5 rounded-r-lg bg-accent pl-1 opacity-0 group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100">
                          {entry.status === "ready" && (
                            <button
                              type="button"
                              title={t("ai.renameChat")}
                              aria-label={t("ai.renameChat")}
                              onClick={() => {
                                setEditing(entry.id)
                                setTitle(entry.title ?? "")
                              }}
                              className="flex size-7 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                            >
                              <Pencil className="size-3.5" />
                            </button>
                          )}
                          <button
                            type="button"
                            title={t("ai.deleteChat")}
                            aria-label={t("ai.deleteChat")}
                            onClick={() => void remove(entry.id)}
                            className="flex size-7 items-center justify-center rounded text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </section>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}
