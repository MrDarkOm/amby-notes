"use client"

import * as React from "react"
import { SmilePlus } from "lucide-react"
import { useTranslation } from "react-i18next"

import { IconValue } from "../icon-value"
import { EmojiPickerPanel } from "../tiptap/EmojiPickerPanel"
import { CLOSE_BLOCK_MENUS_EVENT, CLOSE_EDITOR_MENUS_EVENT } from "../tiptap/floating-menu-events"

export interface DocumentTitleProps {
  title: string
  fileIcon?: string
  editingTitle: boolean
  onEditingTitleChange: (editing: boolean) => void
  onRenameTitle?: (newName: string) => void
  onFileIconChange?: (icon: string) => void
}

export function DocumentTitle({
  title,
  fileIcon,
  editingTitle,
  onEditingTitleChange,
  onRenameTitle,
  onFileIconChange,
}: DocumentTitleProps) {
  const { t } = useTranslation()
  const [titleValue, setTitleValue] = React.useState(title)
  const [emojiPickerOpen, setEmojiPickerOpen] = React.useState(false)
  const titleInputRef = React.useRef<HTMLInputElement>(null)
  const emojiSlotRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    setTitleValue(title)
  }, [title])

  React.useEffect(() => {
    if (editingTitle) {
      setTimeout(() => {
        titleInputRef.current?.select()
        titleInputRef.current?.focus()
      }, 0)
    }
  }, [editingTitle])

  function commitTitleRename() {
    const trimmed = titleValue.trim()
    if (trimmed && trimmed !== title) onRenameTitle?.(trimmed)
    onEditingTitleChange(false)
  }

  function handleTitleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") commitTitleRename()
    if (e.key === "Escape") {
      setTitleValue(title)
      onEditingTitleChange(false)
    }
  }

  const hasPageEmoji = Boolean(
    fileIcon && !/^(folder|file|page|workspace|canvas|draft|brain)$/.test(fileIcon),
  )

  return (
    <div className="amby-page-title relative mb-4 flex items-center gap-3">
      <div
        ref={emojiSlotRef}
        className={hasPageEmoji ? "relative shrink-0" : "absolute -left-10 top-0"}
      >
        {hasPageEmoji ? (
          <button
            type="button"
            className="text-3xl leading-none transition-transform hover:scale-110 focus:outline-none"
            title={t("docEditor.changeIcon")}
            onClick={() => {
              if (emojiPickerOpen) {
                setEmojiPickerOpen(false)
              } else {
                window.dispatchEvent(new Event(CLOSE_BLOCK_MENUS_EVENT))
                window.dispatchEvent(new Event(CLOSE_EDITOR_MENUS_EVENT))
                setEmojiPickerOpen(true)
              }
            }}
          >
            <IconValue value={fileIcon} className="size-8 rounded-md" />
          </button>
        ) : (
          <button
            type="button"
            className="amby-page-emoji-add flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-all hover:bg-accent hover:text-foreground focus:outline-none"
            title={t("docEditor.changeIcon")}
            aria-label={t("docEditor.changeIcon")}
            onClick={() => {
              if (emojiPickerOpen) {
                setEmojiPickerOpen(false)
              } else {
                window.dispatchEvent(new Event(CLOSE_BLOCK_MENUS_EVENT))
                window.dispatchEvent(new Event(CLOSE_EDITOR_MENUS_EVENT))
                setEmojiPickerOpen(true)
              }
            }}
          >
            <SmilePlus className="size-5" />
          </button>
        )}
        {emojiPickerOpen && (
          <div className="absolute left-0 top-full z-50 mt-1">
            <EmojiPickerPanel
              triggerRef={emojiSlotRef}
              onSelect={(emojiData) => {
                onFileIconChange?.(emojiData.native)
                setEmojiPickerOpen(false)
              }}
              onClear={() => {
                onFileIconChange?.("file")
                setEmojiPickerOpen(false)
              }}
              clearLabel={t("tree.resetIcon")}
              onClose={() => setEmojiPickerOpen(false)}
            />
          </div>
        )}
      </div>
      {editingTitle ? (
        <input
          ref={titleInputRef}
          value={titleValue}
          onChange={(e) => setTitleValue(e.target.value)}
          onBlur={commitTitleRename}
          onKeyDown={handleTitleKeyDown}
          className="h-8 flex-1 border-0 bg-transparent p-0 text-2xl font-semibold leading-none tracking-tight text-foreground outline-none sm:h-10 sm:text-3xl"
        />
      ) : (
        <h1
          className="cursor-text text-2xl font-semibold leading-none tracking-tight text-foreground hover:text-primary sm:text-3xl"
          onClick={() => {
            setTitleValue(title)
            onEditingTitleChange(true)
          }}
        >
          {title}
        </h1>
      )}
    </div>
  )
}
