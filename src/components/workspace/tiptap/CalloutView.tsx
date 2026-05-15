"use client"

import * as React from "react"
import { NodeViewWrapper, NodeViewContent } from "@tiptap/react"
import type { NodeViewProps } from "@tiptap/react"

import { EmojiPickerPanel } from "./EmojiPickerPanel"

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
  const [pickerOpen, setPickerOpen] = React.useState(false)
  const emojiSlotRef = React.useRef<HTMLDivElement>(null)
  const { calloutType, emoji } = node.attrs as { calloutType: string; emoji: string }

  function handleEmojiSelect(emojiData: { native: string }) {
    updateAttributes({ emoji: emojiData.native })
    setPickerOpen(false)
  }

  return (
    <NodeViewWrapper
      data-callout-type={calloutType}
      className="amby-callout-node"
    >
      <div className="amby-callout-inner">
        {/* ── Emoji slot ─────────────────────────────────────────────── */}
        <div
          ref={emojiSlotRef}
          className="amby-callout-emoji-slot"
          contentEditable={false}
        >
          <button
            type="button"
            className="amby-callout-emoji-btn"
            onClick={() => {
              if (editor.isEditable) setPickerOpen(v => !v)
            }}
            title={editor.isEditable ? "Change emoji" : undefined}
            aria-label="Callout emoji"
          >
            {emoji}
          </button>

          {pickerOpen && (
            <div
              className="amby-callout-picker-anchor"
              contentEditable={false}
            >
              <EmojiPickerPanel
                onSelect={handleEmojiSelect}
                onClose={() => setPickerOpen(false)}
              />
            </div>
          )}
        </div>

        {/* ── Editable content ────────────────────────────────────────── */}
        <NodeViewContent className="amby-callout-content" />
      </div>
    </NodeViewWrapper>
  )
}
