import { useState } from "react"
import { resolveEmoji } from "@/lib/emoji/emoji-resolver"
import { cn } from "@/lib/utils"

/** An interface icon only. Ordinary editable text deliberately keeps the system renderer. */
export function EmojiGlyph({ value, className }: { value: string; className?: string }) {
  const src = resolveEmoji(value)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  return (
    <span aria-hidden="true" className={cn("amby-emoji-glyph", className)}>
      {src && failedSrc !== src ? (
        <img
          src={src}
          alt=""
          draggable={false}
          decoding="async"
          onError={() => setFailedSrc(src)}
        />
      ) : (
        value
      )}
    </span>
  )
}
