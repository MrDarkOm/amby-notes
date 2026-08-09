"use client"

import * as React from "react"
import Picker from "@emoji-mart/react"
import data from "@emoji-mart/data"
import { useTheme } from "next-themes"

interface EmojiData {
  native: string
}

interface Props {
  onSelect: (emoji: EmojiData) => void
  onClose: () => void
  /** Optional footer action, used by page icons to restore the default icon. */
  onClear?: () => void
  clearLabel?: string
}

/**
 * Theme-aware wrapper around emoji-mart with click-outside dismissal.
 */
export function EmojiPickerPanel({ onSelect, onClose, onClear, clearLabel }: Props) {
  const ref = React.useRef<HTMLDivElement>(null)
  const { resolvedTheme } = useTheme()

  React.useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    // Use capture so we intercept before Tiptap's own click handlers
    document.addEventListener("mousedown", handleClickOutside, true)
    return () => document.removeEventListener("mousedown", handleClickOutside, true)
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
