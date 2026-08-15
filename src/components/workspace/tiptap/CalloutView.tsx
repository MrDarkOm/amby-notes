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
  const { calloutType, emoji, bgColor, hasRawHeader, headerPrefix, headerContentInBody } =
    node.attrs as {
      calloutType: string
      emoji: string
      bgColor: string | null
      hasRawHeader: boolean
      headerPrefix: string
      headerContentInBody: boolean
    }

  function handleEmojiSelect(emojiData: { native: string }) {
    const attrs: Record<string, unknown> = { emoji: emojiData.native }
    if (hasRawHeader) {
      const collapseMarker = /^[+-]/u.exec(headerPrefix)?.[0] ?? ""
      attrs.headerPrefix = `${collapseMarker} ${emojiData.native}${headerContentInBody ? " " : ""}`
      attrs.headerSuffix = attrs.headerPrefix
    }
    updateAttributes(attrs)
    setPickerOpen(false)
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
                emojiOnly
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
          <NodeViewContent className="amby-callout-content" />
        </div>
      </div>
    </NodeViewWrapper>
  )
}
