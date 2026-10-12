import * as React from "react"
import { treeIndent } from "./tree-indent"
import { useTranslation } from "react-i18next"
import { projectErrorText } from "../project-error"

/**
 * A row starts from a menu or a dialog that is still closing and keeps focus trapped for a moment,
 * so the field loses focus the instant it gets it. A blur this early is not the author leaving.
 */
const SETTLE_MS = 300

interface InlineCreateRowProps {
  /** Nesting depth of the row it sits in, so the field lines up with its siblings. */
  depth: number
  icon: React.ReactNode
  placeholder: string
  /** Creates the item. A rejection is shown under the field and the typed name is kept. */
  onSubmit: (title: string) => Promise<void>
  onCancel: () => void
}

/**
 * A new item named where it will stand, as the file tree does it: Enter creates, Escape (or
 * leaving the field empty) cancels, and a name that was typed is created when the field is left.
 * A failure stays on the row, so the typed name is not lost.
 */
export function InlineCreateRow({
  depth,
  icon,
  placeholder,
  onSubmit,
  onCancel,
}: InlineCreateRowProps) {
  const { t } = useTranslation()
  const [value, setValue] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const settled = React.useRef(false)
  const input = React.useRef<HTMLInputElement>(null)
  const born = React.useRef(Date.now())
  const timers = React.useRef<number[]>([])
  React.useEffect(
    () => () => {
      for (const timer of timers.current) window.clearTimeout(timer)
    },
    [],
  )

  const submit = async () => {
    const title = value.trim()
    if (!title) {
      if (!settled.current) {
        settled.current = true
        onCancel()
      }
      return
    }
    if (pending || settled.current) return
    setPending(true)
    setError(null)
    try {
      await onSubmit(title)
      settled.current = true
    } catch (caught) {
      setError(projectErrorText(t, caught))
      setPending(false)
    }
  }

  return (
    <div className="py-0.5 pr-1" style={{ paddingLeft: treeIndent(depth + 1) - 6 }}>
      <div className="flex items-center gap-1.5 rounded-md border border-primary/50 bg-background px-1.5">
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          {icon}
        </span>
        <input
          ref={input}
          autoFocus
          value={value}
          maxLength={100}
          disabled={pending}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            setValue(event.target.value)
            setError(null)
          }}
          onBlur={() => {
            const age = Date.now() - born.current
            if (age < SETTLE_MS) {
              timers.current.push(
                window.setTimeout(() => input.current?.focus(), SETTLE_MS - age + 20),
              )
              return
            }
            if (!pending) void submit()
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === "Enter") {
              event.preventDefault()
              void submit()
            } else if (event.key === "Escape") {
              event.preventDefault()
              settled.current = true
              onCancel()
            }
            event.stopPropagation()
          }}
          className="min-w-0 flex-1 bg-transparent py-1 text-[13px] outline-none placeholder:text-muted-foreground"
        />
      </div>
      {error && (
        <p role="alert" className="px-1.5 pt-1 text-[11px] text-destructive">
          {t("creative.workshop.createFailed", { message: error })}
        </p>
      )}
    </div>
  )
}
