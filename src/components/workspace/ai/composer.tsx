"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { ArrowUp, FileText, Folder, FolderTree, Plus, Square, X } from "lucide-react"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { ModelPicker, type PickerModel } from "./model-picker"
import type { Chat, TreeItem } from "@/lib/storage"
import { cn } from "@/lib/utils"
import { MAX_ATTACHED_CHARS } from "./context"
import { toRelativeVaultPath } from "../workspace-tree-utils"

interface OpenDoc {
  title?: string
  content: string
}

interface ContextLabel {
  entry: Chat["context"][number]
  title: string
  folder: boolean
}

function ContextChip({
  label,
  loading,
  onRemove,
}: {
  label: ContextLabel
  loading: boolean
  onRemove?: () => void
}) {
  const { t } = useTranslation()
  const Icon = label.folder ? Folder : FileText
  return (
    <span className="inline-flex min-h-6 min-w-0 flex-1 items-center gap-1 rounded-md bg-muted pl-1.5 pr-0 text-xs text-foreground">
      <Icon className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{label.title}</span>
      {onRemove && (
        <button
          type="button"
          disabled={loading}
          aria-label={t("ai.removeContext")}
          title={t("ai.removeContext")}
          className="ml-auto flex h-6 w-7 shrink-0 items-center justify-center rounded-r-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          onClick={onRemove}
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  )
}

/**
 * The attached notes in one line: a single note is shown in full with its own remove button; with
 * several only the first is shown plus a counter, and a list of all of them opens while the cursor
 * is over the chip or the list, where each can be detached.
 */
function ContextChips({
  chat,
  flat,
  openDocs,
  truncated,
  vault,
  currentDoc,
  loading,
  onChange,
  getPanel,
}: {
  chat: Chat
  flat: TreeItem[]
  openDocs: Record<string, OpenDoc | undefined>
  truncated: string[]
  vault: string | null
  currentDoc: OpenDoc | null
  loading: boolean
  onChange: (next: Chat) => void
  /** The panel the list must stay inside: it takes its width and starts at its left edge. */
  getPanel: () => HTMLElement | null
}) {
  const { t } = useTranslation()
  const [hover, setHover] = React.useState(false)
  const closeTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined)
  React.useEffect(() => () => clearTimeout(closeTimer.current), [])
  const group = React.useRef<HTMLSpanElement>(null)
  const [box, setBox] = React.useState<{ width: number; alignOffset: number }>()
  const enter = () => {
    clearTimeout(closeTimer.current)
    if (loading) return
    const panel = getPanel()?.getBoundingClientRect()
    const own = group.current?.getBoundingClientRect()
    // As wide as the panel, from its left edge: the same box the model list takes.
    if (panel && own && panel.width > 0)
      setBox({ width: panel.width, alignOffset: panel.left - own.left })
    setHover(true)
  }
  const leave = () => {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setHover(false), 250)
  }

  const labels: ContextLabel[] = chat.context.map((entry) => {
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
    return {
      entry,
      title: `${doc?.title || item?.name || entry.id}${clipped ? ` · ${t("ai.contextTruncated")}` : ""}`,
      folder: entry.kind === "folder",
    }
  })
  const remove = (entry: ContextLabel["entry"]) =>
    onChange({
      ...chat,
      autoCurrent: entry.kind === "current" ? false : chat.autoCurrent,
      context: chat.context.filter((candidate) => candidate !== entry),
    })

  if (labels.length === 0) return null
  if (labels.length === 1)
    return (
      <ContextChip label={labels[0]} loading={loading} onRemove={() => remove(labels[0].entry)} />
    )
  return (
    <Popover open={hover && !loading} onOpenChange={(next) => !next && setHover(false)}>
      <PopoverAnchor asChild>
        <span
          ref={group}
          data-context-group
          className="inline-flex min-w-0 flex-1 items-center gap-1"
          onMouseEnter={enter}
          onMouseLeave={leave}
        >
          <ContextChip label={labels[0]} loading={loading} />
          <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            +{labels.length - 1}
          </span>
        </span>
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={4}
        alignOffset={box?.alignOffset ?? 0}
        style={box ? { width: box.width } : undefined}
        className={cn("max-w-none rounded-xl p-1.5 shadow-md", !box && "w-64")}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onMouseEnter={enter}
        onMouseLeave={leave}
      >
        <ul
          role="list"
          aria-label={t("ai.attachedNotes")}
          className="flex max-h-60 flex-col overflow-y-auto"
          onMouseEnter={enter}
          onMouseLeave={leave}
        >
          {labels.map((label) => {
            const Icon = label.folder ? Folder : FileText
            return (
              <li
                key={`${label.entry.kind}:${label.entry.id}`}
                className="flex min-h-9 items-center gap-2 rounded-lg pl-2 pr-0 text-[13px] hover:bg-accent"
              >
                <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{label.title}</span>
                <button
                  type="button"
                  aria-label={t("ai.removeContext")}
                  title={t("ai.removeContext")}
                  className="flex h-9 w-10 shrink-0 items-center justify-center rounded-r-lg text-muted-foreground hover:bg-background hover:text-foreground"
                  onClick={() => remove(label.entry)}
                >
                  <X className="size-3.5" />
                </button>
              </li>
            )
          })}
        </ul>
      </PopoverContent>
    </Popover>
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
  const [menuBox, setMenuBox] = React.useState<{ width: number; alignOffset: number }>()
  const root = React.useRef<HTMLDivElement>(null)
  const row = React.useRef<HTMLDivElement>(null)
  // The list is as wide as the panel and starts at its left edge, but sits right over this row.
  const toggleMenu = (next: boolean) => {
    if (next && root.current && row.current) {
      const panel = root.current.getBoundingClientRect()
      const own = row.current.getBoundingClientRect()
      setMenuBox({ width: panel.width, alignOffset: panel.left - own.left })
    }
    setMenuOpen(next)
  }
  return (
    <Popover open={menuOpen} onOpenChange={toggleMenu}>
      <div ref={root} className="relative shrink-0 px-3 pb-3 pt-1">
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
        <div data-composer-line className="mb-1.5 flex w-full min-w-0 items-center gap-1.5">
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
            <FolderTree className="size-3.5" aria-hidden="true" />
            <span className="sr-only">{t("ai.searchVault")}</span>
          </label>
          {chat && chat.context.length > 0 ? (
            <ContextChips
              getPanel={() => root.current}
              chat={chat}
              flat={flat}
              openDocs={openDocs}
              truncated={truncated}
              vault={vault}
              currentDoc={currentDoc}
              loading={loading}
              onChange={onChangeChat}
            />
          ) : (
            <span className="min-w-0 flex-1" />
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
          <PopoverAnchor asChild>
            <div ref={row} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <ModelPicker
                  models={models}
                  activeModelId={activeModelId}
                  onModel={onModel}
                  onManage={onManage}
                  menu={{ open: menuOpen, onOpenChange: toggleMenu, ...menuBox }}
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
          </PopoverAnchor>
        </div>
      </div>
    </Popover>
  )
}
