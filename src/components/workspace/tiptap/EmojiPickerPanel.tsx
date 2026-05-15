"use client"

import * as React from "react"
import Picker from "@emoji-mart/react"
import data from "@emoji-mart/data"

interface EmojiData {
  native: string
}

interface Props {
  onSelect: (emoji: EmojiData) => void
  onClose: () => void
}

/**
 * Thin wrapper around emoji-mart's Picker with dark theme and click-outside
 * dismissal. Intended for use inside the CalloutView emoji slot.
 */
export function EmojiPickerPanel({ onSelect, onClose }: Props) {
  const ref = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    // Use capture so we intercept before Tiptap's own click handlers
    document.addEventListener("mousedown", handleClickOutside, true)
    return () => document.removeEventListener("mousedown", handleClickOutside, true)
  }, [onClose])

  return (
    <div ref={ref}>
      <Picker
        data={data}
        onEmojiSelect={(emoji: EmojiData) => onSelect(emoji)}
        theme="dark"
        previewPosition="none"
        skinTonePosition="none"
        set="native"
      />
    </div>
  )
}
