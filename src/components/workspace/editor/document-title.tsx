"use client"

import * as React from "react"
import { SmilePlus } from "lucide-react"
import { useTranslation } from "react-i18next"
import { motion } from "motion/react"

import { motionTransitions } from "@/lib/motion-config"
import { IconValue } from "../icon-value"
import { KNOWN_ICONS } from "../tree/tree-types"
import { renameFailureText, type RenameOutcome } from "../file-actions/rename-outcome"
import { RenameHint } from "../notices/rename-hint"
import { EmojiPickerPanel } from "../tiptap/EmojiPickerPanel"
import { CLOSE_BLOCK_MENUS_EVENT, CLOSE_EDITOR_MENUS_EVENT } from "../tiptap/floating-menu-events"

export interface DocumentTitleProps {
  title: string
  fileIcon?: string
  editingTitle: boolean
  onEditingTitleChange: (editing: boolean) => void
  /** Resolves with how the rename ended; a refused name keeps the field open with the reason under it. */
  onRenameTitle?: (newName: string) => Promise<RenameOutcome | void> | void
  onFileIconChange?: (icon: string) => void
  onSubmit?: () => void
}

export function DocumentTitle({
  title,
  fileIcon,
  editingTitle,
  onEditingTitleChange,
  onRenameTitle,
  onFileIconChange,
  onSubmit,
}: DocumentTitleProps) {
  const { t } = useTranslation()
  const [titleValue, setTitleValue] = React.useState(title)
  const [emojiPickerOpen, setEmojiPickerOpen] = React.useState(false)
  const titleInputRef = React.useRef<HTMLTextAreaElement>(null)
  const emojiSlotRef = React.useRef<HTMLDivElement>(null)
  const renamingRef = React.useRef(false)
  // The name just taken: leaving the field after Enter must not hand it over a second time.
  const settledRef = React.useRef<string | null>(null)
  const [refused, setRefused] = React.useState<{ name: string; text: string } | null>(null)

  React.useEffect(() => {
    setTitleValue(title)
  }, [title])

  React.useEffect(() => {
    if (editingTitle) titleInputRef.current?.focus()
  }, [editingTitle])

  React.useLayoutEffect(() => {
    const field = titleInputRef.current
    if (!field) return
    field.style.height = "0px"
    field.style.height = `${Math.max(field.scrollHeight, 32)}px`
  }, [titleValue])

  /**
   * Hand the typed name over and wait for the outcome. `true` when the field may close; `false` when
   * the name was refused, and then the field stays with the typed name and the reason under it.
   */
  async function commitTitleRename(): Promise<boolean> {
    const trimmed = titleValue.trim()
    if (renamingRef.current) return false
    if (trimmed && trimmed === settledRef.current) {
      onEditingTitleChange(false)
      return true
    }
    // Leaving the field with the refused name still in it gives up, instead of asking again.
    if (!trimmed || trimmed === title || trimmed === refused?.name) {
      giveUp()
      return true
    }
    renamingRef.current = true
    try {
      const outcome = await onRenameTitle?.(trimmed)
      const text = renameFailureText(outcome)
      if (text) {
        setRefused({ name: trimmed, text })
        return false
      }
      setRefused(null)
      settledRef.current = trimmed
      onEditingTitleChange(false)
      return true
    } catch {
      // The rename reports its own failure as an outcome; a throw has nothing to show.
      onEditingTitleChange(false)
      return true
    } finally {
      renamingRef.current = false
    }
  }

  function giveUp() {
    setTitleValue(title)
    setRefused(null)
    onEditingTitleChange(false)
  }

  function handleTitleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault()
      void commitTitleRename().then((closed) => {
        if (!closed) return
        titleInputRef.current?.blur()
        onSubmit?.()
      })
    }
    if (e.key === "Escape") giveUp()
  }

  const hintText = refused && titleValue.trim() === refused.name ? refused.text : null

  const hasPageEmoji = Boolean(fileIcon && !KNOWN_ICONS.has(fileIcon))

  return (
    <div className="amby-page-title relative mb-4 flex items-center gap-3">
      <div
        ref={emojiSlotRef}
        className={hasPageEmoji ? "relative shrink-0" : "absolute -left-10 top-0"}
      >
        {hasPageEmoji ? (
          <motion.button
            type="button"
            className="text-3xl leading-none focus:outline-none"
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.96 }}
            transition={motionTransitions.default}
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
            <IconValue value={fileIcon} className="size-8 rounded-md text-3xl" />
          </motion.button>
        ) : (
          <motion.button
            type="button"
            className="amby-page-emoji-add flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus:outline-none"
            whileHover={{ scale: 1.06 }}
            whileTap={{ scale: 0.96 }}
            transition={motionTransitions.default}
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
          </motion.button>
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
      <textarea
        ref={titleInputRef}
        rows={1}
        wrap="soft"
        value={titleValue}
        readOnly={!editingTitle}
        aria-label={title}
        aria-invalid={hintText ? true : undefined}
        aria-describedby={hintText ? "document-title-rename-hint" : undefined}
        onFocus={() => {
          if (!editingTitle) onEditingTitleChange(true)
        }}
        onChange={(e) => {
          settledRef.current = null
          setTitleValue(e.target.value)
        }}
        onBlur={() => void commitTitleRename()}
        onKeyDown={handleTitleKeyDown}
        className="min-h-8 min-w-0 flex-1 cursor-text resize-none overflow-hidden whitespace-pre-wrap break-words border-0 bg-transparent p-0 text-2xl font-semibold leading-tight tracking-tight text-foreground outline-none sm:text-3xl"
      />
      {hintText && (
        <RenameHint
          id="document-title-rename-hint"
          text={hintText}
          className="absolute left-0 top-full z-10 mt-1 max-w-full"
        />
      )}
    </div>
  )
}
