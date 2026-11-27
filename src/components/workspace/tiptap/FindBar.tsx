"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import { ChevronDown, ChevronUp, List, X } from "lucide-react"
import type { Editor } from "@tiptap/react"

import { clearFind, readFind, selectFind, setFindQuery, stepFind } from "./find-in-note"
import { isEnterKey } from "@/lib/keyboard"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { notePageAtPosition, notePagesKey, revealNotePageAt } from "./note-pages"

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
    if (editor.isDestroyed) return
    const { matches, current } = readFind(editor.state)
    const match = matches[current]
    if (match) revealNotePageAt(editor, match.from)
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
  const pages = editor.isDestroyed ? null : notePagesKey.getState(editor.state)
  const paged = pages?.enabled && pages.pages.length > 1
  const pageName = (position: number) => {
    const index = notePageAtPosition(editor.state, position)
    const title = pages?.pages[index]?.title
    return title === null
      ? t("docEditor.notePages.introduction")
      : title || t("docEditor.notePages.untitled", { number: index + 1 })
  }
  const selected = found && found.matches[found.current]
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
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.defaultPrevented) {
            event.preventDefault()
            close()
          }
        }}
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
            if (isEnterKey(event)) {
              event.preventDefault()
              step(event.shiftKey ? -1 : 1)
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
        {paged && found && selected ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={buttonClass}
                aria-label={t("docEditor.notePages.findResults")}
                title={pageName(selected.from)}
              >
                <List className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-80 w-72 overflow-y-auto">
              {found.matches.map((match, index) => {
                const position = editor.state.doc.resolve(match.from)
                const offset = position.parentOffset
                const text = position.parent.textBetween(
                  Math.max(0, offset - 30),
                  Math.min(position.parent.content.size, offset + 70),
                  " ",
                  " ",
                )
                return (
                  <DropdownMenuItem
                    key={match.from}
                    className="block min-w-0"
                    onSelect={() => {
                      selectFind(editor.view, index)
                      showCurrent()
                    }}
                  >
                    <span className="block truncate font-medium">{pageName(match.from)}</span>
                    <span className="block truncate text-muted-foreground">{text}</span>
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
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
