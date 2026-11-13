import * as React from "react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import { renameFailureText } from "../../file-actions/rename-outcome"
import { RenameHint } from "../../notices/rename-hint"

interface CardTitleInputProps {
  value: string
  /**
   * Saves the new title; a rejection puts the old one back. A rename that resolves to a refusal
   * (`RenameOutcome`) keeps the typed title and says why under the field (docs/notices.md, section 8).
   */
  onCommit: (name: string) => Promise<unknown> | void
  /** Accessible name; defaults to the record title. */
  label?: string
  inputRef?: React.Ref<HTMLInputElement>
  className?: string
  /**
   * Show why a refused title was refused. Opt-in because it wraps the field with the line under it,
   * and the other users of this field (settings of a property or a view) lay it out on their own.
   */
  refusalHint?: boolean
}

/** The title of a card in edit mode: Enter or leaving the field saves, Escape cancels. */
export function CardTitleInput({
  value,
  onCommit,
  label,
  inputRef,
  className,
  refusalHint = false,
}: CardTitleInputProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = React.useState(value)
  const [busy, setBusy] = React.useState(false)
  const committing = React.useRef(false)
  const ownRef = React.useRef<HTMLInputElement>(null)
  const hintId = React.useId()
  // The title that was refused and why; the line stays while the field holds that title.
  const [refused, setRefused] = React.useState<{ name: string; text: string } | null>(null)

  React.useEffect(() => {
    if (!busy && !refused) setDraft(value)
  }, [busy, refused, value])

  async function commit() {
    if (committing.current) return
    const next = draft.trim()
    // Leaving the field with the refused title still in it gives up, instead of asking again.
    if (!next || next === value || next === refused?.name) {
      setDraft(value)
      setRefused(null)
      return
    }
    committing.current = true
    setBusy(true)
    try {
      const outcome = await onCommit(next)
      const text = refusalHint ? renameFailureText(outcome as never) : null
      if (text) setRefused({ name: next, text })
    } catch {
      setDraft(value)
    } finally {
      committing.current = false
      setBusy(false)
    }
  }

  // The field takes the person back to fix a refused title (it is enabled again once `busy` ends).
  React.useEffect(() => {
    if (refused) ownRef.current?.focus()
  }, [refused])
  const hintText = refused && draft.trim() === refused.name ? refused.text : null

  const field = (
    <input
      ref={(node) => {
        ownRef.current = node
        if (typeof inputRef === "function") inputRef(node)
        else if (inputRef)
          (inputRef as React.MutableRefObject<HTMLInputElement | null>).current = node
      }}
      value={draft}
      disabled={busy}
      aria-label={label ?? t("databaseCard.title")}
      aria-invalid={hintText ? true : undefined}
      aria-describedby={hintText ? hintId : undefined}
      className={cn(
        "min-w-0 rounded bg-transparent px-1 py-0.5 outline-none ring-1 ring-border focus:ring-1 focus:ring-ring disabled:opacity-60",
        refusalHint ? "w-full" : "flex-1",
        className,
      )}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void commit()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === "Enter") {
          event.preventDefault()
          event.currentTarget.blur()
        }
        if (event.key === "Escape") {
          event.preventDefault()
          setDraft(value)
          event.currentTarget.blur()
        }
      }}
    />
  )
  if (!refusalHint) return field
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      {field}
      {hintText && <RenameHint id={hintId} text={hintText} />}
    </div>
  )
}
