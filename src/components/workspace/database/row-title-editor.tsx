import * as React from "react"
import { createPortal } from "react-dom"
import { cn } from "@/lib/utils"
import { renameFailureText, type RenameOutcome } from "../file-actions/rename-outcome"
import { RenameHint } from "../notices/rename-hint"

/**
 * A row's name: a plain label that is a pointer, and a click lifts a larger field over it (as
 * Notion does), so a long name can be read and typed whole. Enter or leaving the field saves it,
 * Escape puts the old name back. A name that was refused keeps the field open with the typed name and
 * the reason under it (docs/notices.md, section 8).
 */
export function RowTitleEditor({
  value,
  onCommit,
  className,
}: {
  value: string
  onCommit?: (name: string) => Promise<RenameOutcome | void> | void
  className?: string
}) {
  const buttonRef = React.useRef<HTMLButtonElement>(null)
  const [box, setBox] = React.useState<DOMRect | null>(null)
  const [draft, setDraft] = React.useState(value)
  const doneRef = React.useRef(false)
  const [refused, setRefused] = React.useState<{ name: string; text: string } | null>(null)

  const open = () => {
    const rect = (
      buttonRef.current?.closest('[role="gridcell"]') ?? buttonRef.current
    )?.getBoundingClientRect()
    if (!rect || !onCommit) return
    doneRef.current = false
    setDraft(value)
    setRefused(null)
    setBox(rect)
  }
  const finish = (save: boolean) => {
    if (doneRef.current) return
    doneRef.current = true
    const next = draft.trim()
    // Leaving the field with the refused name still in it gives up, instead of asking again.
    if (!save || !next || next === value || next === refused?.name) {
      setBox(null)
      setRefused(null)
      // The label comes back to where the focus was.
      buttonRef.current?.focus({ preventScroll: true })
      return
    }
    void Promise.resolve(onCommit?.(next))
      .then((outcome) => {
        const text = renameFailureText(outcome)
        if (text) {
          // The field stays, with the name as typed and the reason under it.
          setRefused({ name: next, text })
          doneRef.current = false
          return
        }
        setBox(null)
        setRefused(null)
        buttonRef.current?.focus({ preventScroll: true })
      })
      // The rename reports its own failure as an outcome; a throw here has nothing to show.
      .catch(() => setBox(null))
  }
  const hintText = refused && draft.trim() === refused.name ? refused.text : null

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        disabled={!onCommit}
        title={value}
        className={cn(
          "min-w-0 flex-1 cursor-pointer truncate text-left text-sm font-medium text-foreground outline-none disabled:cursor-default",
          className,
        )}
        onClick={(event) => {
          event.stopPropagation()
          open()
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {value}
      </button>
      {box &&
        createPortal(
          <>
            <input
              autoFocus
              value={draft}
              aria-label={value}
              aria-invalid={hintText ? true : undefined}
              aria-describedby={hintText ? "row-title-rename-hint" : undefined}
              className="fixed z-[200] h-11 rounded-lg border border-border bg-popover px-3.5 text-[15px] font-semibold text-popover-foreground shadow-xl outline-none ring-2 ring-ring/40"
              style={{
                left: Math.max(8, box.left - 6),
                top: box.top + box.height / 2 - 22,
                width: Math.max(box.width + 12, 320),
              }}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => finish(true)}
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation()
                if (event.key === "Enter") {
                  event.preventDefault()
                  finish(true)
                }
                if (event.key === "Escape") {
                  event.preventDefault()
                  finish(false)
                }
              }}
            />
            {hintText && (
              <RenameHint
                id="row-title-rename-hint"
                text={hintText}
                className="fixed z-[200]"
                style={{
                  left: Math.max(8, box.left - 6),
                  top: box.top + box.height / 2 + 26,
                  width: Math.max(box.width + 12, 320),
                }}
              />
            )}
          </>,
          document.body,
        )}
    </>
  )
}
