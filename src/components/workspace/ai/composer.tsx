"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { ArrowUp, FileText, Folder, Plus, Search, Square, X } from "lucide-react"
import { Popover, PopoverAnchor } from "@/components/ui/popover"
import { ModelPicker, type PickerModel } from "./model-picker"
import type { Chat, TreeItem } from "@/lib/storage"
import { cn } from "@/lib/utils"
import { MAX_ATTACHED_CHARS } from "./context"
import { toRelativeVaultPath } from "../workspace-tree-utils"

interface OpenDoc {
  title?: string
  content: string
}

function ContextChips({
  chat,
  flat,
  openDocs,
  truncated,
  vault,
  currentDoc,
  loading,
  onChange,
}: {
  chat: Chat
  flat: TreeItem[]
  openDocs: Record<string, OpenDoc | undefined>
  truncated: string[]
  vault: string | null
  currentDoc: OpenDoc | null
  loading: boolean
  onChange: (next: Chat) => void
}) {
  const { t } = useTranslation()
  return (
    <>
      {chat.context.map((entry) => {
        const item =
          entry.kind === "folder"
            ? flat.find(
                (candidate) =>
                  candidate.type === "folder" &&
                  toRelativeVaultPath(candidate.path, vault) === entry.id,
              )
            : flat.find((candidate) => candidate.id === entry.id)
        const doc = openDocs[entry.id]
        const clipped =
          truncated.includes(entry.id) ||
          (entry.kind === "current" &&
            !!currentDoc &&
            Array.from(currentDoc.content).length > MAX_ATTACHED_CHARS)
        return (
          <span
            key={`${entry.kind}:${entry.id}`}
            className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md bg-muted py-0.5 pl-1.5 pr-1 text-xs text-foreground"
          >
            {entry.kind === "folder" ? (
              <Folder className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
            ) : (
              <FileText className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <span className="truncate">
              {doc?.title || item?.name || entry.id}
              {clipped ? ` · ${t("ai.contextTruncated")}` : ""}
            </span>
            <button
              type="button"
              disabled={loading}
              aria-label={t("ai.removeContext")}
              title={t("ai.removeContext")}
              className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
              onClick={() =>
                onChange({
                  ...chat,
                  autoCurrent: entry.kind === "current" ? false : chat.autoCurrent,
                  context: chat.context.filter((candidate) => candidate !== entry),
                })
              }
            >
              <X className="size-3" />
            </button>
          </span>
        )
      })}
    </>
  )
}

/** One capsule for everything you type with: context, the message, search, model, send. */
export function Composer({
  chat,
  flat,
  openDocs,
  truncated,
  vault,
  currentDoc,
  input,
  loading,
  switching,
  tools,
  mentionOpen,
  choices,
  models,
  activeModelId,
  onChangeChat,
  onAddCurrent,
  onInput,
  onSend,
  onStop,
  onPickMention,
  onModel,
  onManage,
}: {
  chat: Chat | null
  flat: TreeItem[]
  openDocs: Record<string, OpenDoc | undefined>
  truncated: string[]
  vault: string | null
  currentDoc: OpenDoc | null
  input: string
  loading: boolean
  switching: boolean
  tools: boolean
  mentionOpen: boolean
  choices: TreeItem[]
  models: PickerModel[]
  activeModelId: string
  onChangeChat: (next: Chat) => void
  onAddCurrent: () => void
  onInput: (value: string) => void
  onSend: () => void
  onStop: () => void
  onPickMention: (item: TreeItem) => void
  onModel: (id: string) => void
  onManage: () => void
}) {
  const { t } = useTranslation()
  const searchOn = !!chat?.searchEnabled && tools
  const field = React.useRef<HTMLTextAreaElement>(null)
  const [menuOpen, setMenuOpen] = React.useState(false)
  return (
    <Popover open={menuOpen} onOpenChange={setMenuOpen}>
      <PopoverAnchor asChild>
        <div className="relative shrink-0 px-3 pb-3 pt-1">
          {mentionOpen && !loading && (
            <div
              role="listbox"
              aria-label={t("ai.addMention")}
              className="absolute bottom-full left-3 right-3 max-h-48 overflow-auto rounded-lg border border-border bg-popover p-1 shadow-lg"
            >
              {choices.length ? (
                choices.map((item) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected="false"
                    key={item.id}
                    onClick={() => onPickMention(item)}
                    className="flex w-full items-center gap-1.5 truncate rounded px-2 py-1 text-left text-xs hover:bg-accent"
                  >
                    {item.type === "folder" ? (
                      <Folder className="size-3 shrink-0" />
                    ) : (
                      <FileText className="size-3 shrink-0" />
                    )}
                    <span className="truncate">{item.name}</span>
                  </button>
                ))
              ) : (
                <p className="p-2 text-xs text-muted-foreground">{t("ai.noMentions")}</p>
              )}
            </div>
          )}
          <div
            data-composer-line
            className="mb-1.5 flex min-w-0 items-center gap-1.5 overflow-hidden px-0.5"
          >
            <label
              title={!tools ? t("ai.toolsDisabled") : t("ai.searchVault")}
              className={cn(
                "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md",
                searchOn
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
                (!tools || loading || !chat) && "cursor-default opacity-40 hover:bg-transparent",
              )}
            >
              <input
                type="checkbox"
                className="sr-only"
                disabled={!tools || loading || !chat}
                checked={searchOn}
                onChange={(event) => {
                  if (chat) onChangeChat({ ...chat, searchEnabled: event.target.checked })
                }}
              />
              <Search className="size-3.5" aria-hidden="true" />
              <span className="sr-only">{t("ai.searchVault")}</span>
            </label>
            {chat && (
              <ContextChips
                chat={chat}
                flat={flat}
                openDocs={openDocs}
                truncated={truncated}
                vault={vault}
                currentDoc={currentDoc}
                loading={loading}
                onChange={onChangeChat}
              />
            )}
            {chat && !chat.autoCurrent && currentDoc && (
              <button
                type="button"
                disabled={loading}
                onClick={onAddCurrent}
                className="shrink-0 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
              >
                {t("ai.addContext")}
              </button>
            )}
            <button
              type="button"
              disabled={loading || !chat}
              title={t("ai.addMention")}
              aria-label={t("ai.addMention")}
              onClick={() => {
                onInput(input === "" || /\s$/u.test(input) ? `${input}@` : `${input} @`)
                field.current?.focus()
              }}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              <Plus className="size-3.5" />
            </button>
          </div>
          <div
            data-composer-box
            className="flex flex-col gap-1.5 rounded-2xl border border-border bg-card p-2 shadow-sm focus-within:border-ring"
          >
            <textarea
              ref={field}
              value={input}
              onChange={(event) => onInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !mentionOpen) {
                  event.preventDefault()
                  onSend()
                }
              }}
              rows={2}
              placeholder={t("ai.messagePlaceholder")}
              className="min-h-[2.75rem] w-full resize-none bg-transparent px-1 text-[14px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
            />
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <ModelPicker
                  models={models}
                  activeModelId={activeModelId}
                  onModel={onModel}
                  onManage={onManage}
                  menu={{ open: menuOpen, onOpenChange: setMenuOpen }}
                />
              </div>
              {loading ? (
                <button
                  type="button"
                  onClick={onStop}
                  title={t("ai.stop")}
                  aria-label={t("ai.stop")}
                  className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border text-foreground hover:bg-accent"
                >
                  <Square className="size-3 fill-current" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onSend}
                  disabled={!input.trim() || switching || !chat}
                  title={t("ai.send")}
                  aria-label={t("ai.send")}
                  className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-30"
                >
                  <ArrowUp className="size-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      </PopoverAnchor>
    </Popover>
  )
}
