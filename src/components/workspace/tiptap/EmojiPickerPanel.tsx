"use client"

import * as React from "react"
import Picker from "@emoji-mart/react"
import data from "@emoji-mart/data"
import { useTheme } from "next-themes"
import { CLOSE_BLOCK_MENUS_EVENT, CLOSE_EDITOR_MENUS_EVENT } from "./floating-menu-events"

interface EmojiData {
  native: string
}

interface Props {
  onSelect: (emoji: EmojiData) => void
  onClose: () => void
  /** Trigger is considered part of the picker for outside-click handling. */
  triggerRef?: React.RefObject<HTMLElement | null>
  /** Optional footer action, used by page icons to restore the default icon. */
  onClear?: () => void
  clearLabel?: string
}

/**
 * Theme-aware wrapper around emoji-mart with click-outside dismissal.
 */
export function EmojiPickerPanel({ onSelect, onClose, triggerRef, onClear, clearLabel }: Props) {
  const ref = React.useRef<HTMLDivElement>(null)
  const { resolvedTheme } = useTheme()

  React.useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node
      if (triggerRef?.current?.contains(target)) return
      if (ref.current && !ref.current.contains(target)) onClose()
    }
    // Use capture so we intercept before Tiptap's own click handlers
    document.addEventListener("mousedown", handleClickOutside, true)
    return () => document.removeEventListener("mousedown", handleClickOutside, true)
  }, [onClose, triggerRef])

  // Block controls, slash menus and emoji pickers are independent portals.
  // Listen to their shared close signals so two floating panels can never
  // remain stacked over one another.
  React.useEffect(() => {
    window.addEventListener(CLOSE_BLOCK_MENUS_EVENT, onClose)
    window.addEventListener(CLOSE_EDITOR_MENUS_EVENT, onClose)
    return () => {
      window.removeEventListener(CLOSE_BLOCK_MENUS_EVENT, onClose)
      window.removeEventListener(CLOSE_EDITOR_MENUS_EVENT, onClose)
    }
  }, [onClose])

  return (
    <div ref={ref} className="amby-emoji-picker-panel">
      <Picker
        data={data}
        onEmojiSelect={(emoji: EmojiData) => onSelect(emoji)}
        theme={resolvedTheme === "dark" ? "dark" : "light"}
        previewPosition="none"
        skinTonePosition="none"
        set="native"
      />
      {onClear && (
        <div className="border-t border-border p-1.5">
          <button
            type="button"
            className="w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={onClear}
          >
            {clearLabel ?? "Remove emoji"}
          </button>
        </div>
      )}
    </div>
  )
}
