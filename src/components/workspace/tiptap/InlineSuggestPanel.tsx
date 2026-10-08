"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { FileText, Hash } from "lucide-react"
import type { Editor } from "@tiptap/react"

import { cn } from "@/lib/utils"
import { clamp } from "./constants"
import { INLINE_SUGGEST_EVENT, readInlineSuggest, type InlineSuggestState } from "./inline-suggest"

const PANEL_WIDTH = 280
const ROW_HEIGHT = 30

/** The list of notes or tags offered while `[[` or `#` is being typed. */
export function InlineSuggestPanel({ editor }: { editor: Editor }) {
  const [state, setState] = React.useState<InlineSuggestState | null>(null)

  React.useEffect(() => {
    if (editor.isDestroyed) return
    const read = () => {
      if (editor.isDestroyed) return
      const next = readInlineSuggest(editor)
      // A copy, so that React sees the change.
      setState(next ? { ...next } : null)
    }
    read()
    window.addEventListener(INLINE_SUGGEST_EVENT, read)
    return () => window.removeEventListener(INLINE_SUGGEST_EVENT, read)
  }, [editor])

  if (!state?.open || !state.rect || state.items.length === 0) return null

  const height = state.items.length * ROW_HEIGHT + 8
  const left = clamp(state.rect.left, 8, window.innerWidth - PANEL_WIDTH - 8)
  const below = state.rect.bottom + 6
  const top = below + height < window.innerHeight - 8 ? below : state.rect.top - height - 6
  const Icon = state.kind === "tag" ? Hash : FileText

  return createPortal(
    <div
      role="listbox"
      data-inline-suggest={state.kind ?? undefined}
      className="fixed z-[85] flex flex-col rounded-lg border border-border bg-popover p-1 text-foreground shadow-lg"
      style={{ left, top: Math.max(8, top), width: PANEL_WIDTH }}
      // The editor keeps the focus and the selection while the list is used.
      onMouseDown={(event) => event.preventDefault()}
    >
      {state.items.map((item, index) => (
        <button
          key={item.value}
          type="button"
          role="option"
          aria-selected={index === state.index}
          className={cn(
            "flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-left text-[13px]",
            index === state.index ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
          )}
          onClick={() => state.select(index)}
        >
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {item.detail ? (
            <span className="max-w-[45%] shrink-0 truncate text-[11px] text-muted-foreground">
              {item.detail}
            </span>
          ) : null}
        </button>
      ))}
    </div>,
    document.body,
  )
}
