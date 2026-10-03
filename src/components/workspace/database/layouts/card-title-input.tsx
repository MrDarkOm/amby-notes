import * as React from "react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"

interface CardTitleInputProps {
  value: string
  /** Saves the new title; a rejection puts the old one back. */
  onCommit: (name: string) => Promise<void> | void
  /** Accessible name; defaults to the record title. */
  label?: string
  inputRef?: React.Ref<HTMLInputElement>
  className?: string
}

/** The title of a card in edit mode: Enter or leaving the field saves, Escape cancels. */
export function CardTitleInput({
  value,
  onCommit,
  label,
  inputRef,
  className,
}: CardTitleInputProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = React.useState(value)
  const [busy, setBusy] = React.useState(false)
  const committing = React.useRef(false)

  React.useEffect(() => {
    if (!busy) setDraft(value)
  }, [busy, value])

  async function commit() {
    if (committing.current) return
    const next = draft.trim()
    if (!next || next === value) {
      setDraft(value)
      return
    }
    committing.current = true
    setBusy(true)
    try {
      await onCommit(next)
    } catch {
      setDraft(value)
    } finally {
      committing.current = false
      setBusy(false)
    }
  }

  return (
    <input
      ref={inputRef}
      value={draft}
      disabled={busy}
      aria-label={label ?? t("databaseCard.title")}
      className={cn(
        "min-w-0 flex-1 rounded bg-transparent px-1 py-0.5 outline-none ring-1 ring-border focus:ring-2 focus:ring-ring disabled:opacity-60",
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
}
