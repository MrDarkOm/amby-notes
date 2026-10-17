"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import { ChevronDown, ChevronUp, X } from "lucide-react"
import type { Editor } from "@tiptap/react"

import { clearFind, readFind, setFindQuery, stepFind } from "./find-in-note"

interface FindBarProps {
  editor: Editor
  /** Text the bar starts with (the selection at the moment it was opened). */
  initialQuery: string
  /** Changes every time the bar is asked for, so an open bar takes the focus again. */
  request: number
  onClose: () => void
}

/** The find bar of Live and Read: a field, the count, previous / next, close. */
export function FindBar({ editor, initialQuery, request, onClose }: FindBarProps) {
  const { t } = useTranslation()
  // The pane around the note's scroll area: the bar sits in its top-right corner, where it
  // stays put while the note scrolls. An editor outside the document pane keeps the bar inline.
  const [overlayHost] = React.useState(
    () => editor.view.dom.closest<HTMLElement>(".amby-editor-scroll")?.parentElement ?? null,
  )
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [query, setQuery] = React.useState(initialQuery)
  const [, setVersion] = React.useState(0)

  // The count follows the note: typing in it while the bar is open changes the matches.
  React.useEffect(() => {
    const update = () => setVersion((version) => version + 1)
    editor.on("transaction", update)
    return () => {
      editor.off("transaction", update)
    }
  }, [editor])

  React.useEffect(() => {
    if (initialQuery) setQuery(initialQuery)
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [initialQuery, request])

  React.useEffect(() => {
    if (!editor.isDestroyed) setFindQuery(editor.view, query)
  }, [editor, query])

  // Closing by any route (Escape, the button, the editor going away) ends the search.
  React.useEffect(
    () => () => {
      if (!editor.isDestroyed) clearFind(editor.view)
    },
    [editor],
  )

  const showCurrent = React.useCallback(() => {
    requestAnimationFrame(() => {
      if (editor.isDestroyed) return
      editor.view.dom
        .querySelector(".amby-find-current")
        ?.scrollIntoView({ block: "center", inline: "nearest" })
    })
  }, [editor])

  React.useEffect(showCurrent, [query, showCurrent])

  const step = (by: 1 | -1) => {
    if (editor.isDestroyed) return
    stepFind(editor.view, by)
    showCurrent()
  }

  const close = () => {
    onClose()
    // The cursor lands on the match that was current (see `clearFind`).
    requestAnimationFrame(() => {
      if (!editor.isDestroyed) editor.view.focus()
    })
  }

  const found = editor.isDestroyed ? null : readFind(editor.state)
  const total = found?.matches.length ?? 0
  const status = !query
    ? ""
    : total === 0
      ? t("editor.find.none")
      : t("editor.find.count", { current: (found?.current ?? 0) + 1, total })
  const buttonClass =
    "flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"

  const bar = (
    <div
      className={
        overlayHost
          ? "pointer-events-none absolute top-2 right-4 z-20"
          : "pointer-events-none sticky top-2 z-20 flex h-0 justify-end"
      }
    >
      <div
        role="search"
        className="amby-find-bar pointer-events-auto flex h-9 items-center gap-1 rounded-lg border border-border bg-popover px-2 text-foreground shadow-lg"
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          aria-label={t("editor.find.placeholder")}
          placeholder={t("editor.find.placeholder")}
          className="w-44 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              step(event.shiftKey ? -1 : 1)
            } else if (event.key === "Escape") {
              event.preventDefault()
              close()
            } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
              // The bar is already open: keep the browser's own find away.
              event.preventDefault()
              event.currentTarget.select()
            }
          }}
        />
        <span
          aria-live="polite"
          className="min-w-[4.5rem] text-right text-[11px] tabular-nums text-muted-foreground"
        >
          {status}
        </span>
        <button
          type="button"
          className={buttonClass}
          title={t("editor.find.previous")}
          disabled={total === 0}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => step(-1)}
        >
          <ChevronUp className="size-3.5" />
        </button>
        <button
          type="button"
          className={buttonClass}
          title={t("editor.find.next")}
          disabled={total === 0}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => step(1)}
        >
          <ChevronDown className="size-3.5" />
        </button>
        <button
          type="button"
          className={buttonClass}
          title={t("editor.find.close")}
          onClick={close}
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  )

  return overlayHost ? createPortal(bar, overlayHost) : bar
}
