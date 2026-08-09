"use client"

import * as React from "react"
import { NodeViewWrapper, NodeViewContent } from "@tiptap/react"
import type { NodeViewProps } from "@tiptap/react"
import { useTranslation } from "react-i18next"

import { EmojiPickerPanel } from "./EmojiPickerPanel"
import { CLOSE_BLOCK_MENUS_EVENT, CLOSE_EDITOR_MENUS_EVENT } from "./floating-menu-events"

/**
 * React NodeView for the `callout` node.
 *
 * Visual: Notion-style rounded container with a left color accent, a centered
 * emoji slot, and an editable content area. Clicking the emoji opens the
 * emoji picker (only in editable mode).
 *
 * The border / background color is determined by data-callout-type and CSS.
 */
export function CalloutView({ node, updateAttributes, editor }: NodeViewProps) {
  const { t } = useTranslation()
  const [pickerOpen, setPickerOpen] = React.useState(false)
  const emojiSlotRef = React.useRef<HTMLDivElement>(null)
  const { calloutType, emoji, bgColor, headerSuffix } = node.attrs as {
    calloutType: string
    emoji: string
    bgColor: string | null
    headerSuffix: string
  }
  const rawHeader = headerSuffix.replace(/^[+-]/u, "").trim()
  const title = rawHeader.replace(
    /^\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*\s*/u,
    "",
  )
  const collapseMarker = /^[+-]/u.exec(headerSuffix)?.[0] ?? ""
  const [titleDraft, setTitleDraft] = React.useState(title)
  const titleInputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (document.activeElement !== titleInputRef.current) setTitleDraft(title)
  }, [title])

  function buildHeaderSuffix(nextEmoji: string, nextTitle: string) {
    return `${collapseMarker} ${nextEmoji}${nextTitle ? ` ${nextTitle}` : ""}`
  }

  function handleEmojiSelect(emojiData: { native: string }) {
    updateAttributes({
      emoji: emojiData.native,
      headerSuffix: buildHeaderSuffix(emojiData.native, titleDraft),
      hasRawHeader: true,
    })
    setPickerOpen(false)
  }

  function handleTitleChange(nextTitle: string) {
    setTitleDraft(nextTitle)
    updateAttributes({
      headerSuffix: buildHeaderSuffix(emoji, nextTitle),
      hasRawHeader: true,
    })
  }

  return (
    <NodeViewWrapper
      data-callout-type={calloutType}
      data-bg={bgColor ?? undefined}
      className="amby-callout-node"
    >
      <div className="amby-callout-inner">
        {/* ── Emoji slot ─────────────────────────────────────────────── */}
        <div ref={emojiSlotRef} className="amby-callout-emoji-slot" contentEditable={false}>
          <button
            type="button"
            className="amby-callout-emoji-btn"
            onClick={() => {
              if (!editor.isEditable) return
              // A second click is an explicit close. Opening broadcasts first
              // so any block/grid/menu portal closes before this picker mounts.
              if (pickerOpen) {
                setPickerOpen(false)
              } else {
                window.dispatchEvent(new Event(CLOSE_BLOCK_MENUS_EVENT))
                window.dispatchEvent(new Event(CLOSE_EDITOR_MENUS_EVENT))
                setPickerOpen(true)
              }
            }}
            title={editor.isEditable ? t("callout.changeEmoji") : undefined}
            aria-label={t("callout.emoji")}
          >
            {emoji}
          </button>

          {pickerOpen && (
            <div className="amby-callout-picker-anchor" contentEditable={false}>
              <EmojiPickerPanel
                triggerRef={emojiSlotRef}
                onSelect={handleEmojiSelect}
                onClose={() => setPickerOpen(false)}
              />
            </div>
          )}
        </div>

        {/* ── Editable content ────────────────────────────────────────── */}
        {/* `NodeViewContent` must live inside a real flex child.  ProseMirror
            renders its block children directly into this element; without the
            wrapper those blocks participate in the outer flex layout and wrap
            underneath the emoji one character wide. */}
        <div className="amby-callout-content-wrap">
          {editor.isEditable ? (
            <input
              ref={titleInputRef}
              type="text"
              className="amby-callout-title amby-callout-title-input"
              value={titleDraft}
              placeholder={t("callout.titlePlaceholder")}
              contentEditable={false}
              onChange={(event) => handleTitleChange(event.target.value)}
              onMouseDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            />
          ) : (
            title && <div className="amby-callout-title">{title}</div>
          )}
          <NodeViewContent className="amby-callout-content" />
        </div>
      </div>
    </NodeViewWrapper>
  )
}
