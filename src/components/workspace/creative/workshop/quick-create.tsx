import * as React from "react"
import { Plus } from "lucide-react"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { NoticeLine } from "@/components/workspace/notices/notice-line"

interface QuickCreateProps {
  /** The button that opens the field. */
  label: string
  card?: boolean
  placeholder: string
  /** Shown under the field when `onCreate` rejects; gets the message. */
  failed: (message: string) => string
  /** Makes the item under the typed name; a rejection stays on the field. */
  onCreate: (title: string) => Promise<void>
  /** The words for a rejection. */
  describe: (error: unknown) => string
}

/**
 * A button that opens one field: Enter makes the item, Escape closes. A failure is shown under the
 * field with the typed name kept, so nothing is lost and nothing is swallowed.
 */
export function QuickCreate({
  label,
  card = false,
  placeholder,
  failed,
  onCreate,
  describe,
}: QuickCreateProps) {
  const [naming, setNaming] = React.useState(false)
  const [title, setTitle] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const trimmed = title.trim()
    if (!trimmed || pending) return
    setPending(true)
    setError(null)
    try {
      await onCreate(trimmed)
      setTitle("")
      setNaming(false)
    } catch (caught) {
      setError(describe(caught))
    } finally {
      setPending(false)
    }
  }

  if (!naming) {
    return (
      <button
        type="button"
        onClick={() => setNaming(true)}
        className={
          card
            ? "amby-creative-gallery-card amby-creative-gallery-create-card flex h-full w-full items-center justify-center gap-2 text-sm"
            : "flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        }
      >
        <Plus aria-hidden="true" className={cn("shrink-0", card ? "size-4" : "size-3.5")} />
        <span
          className={
            card ? "flex min-h-10 min-w-0 items-center break-words leading-snug" : undefined
          }
        >
          {label}
        </span>
      </button>
    )
  }
  return (
    <form
      onSubmit={(event) => void submit(event)}
      className={cn(
        "flex flex-col gap-1",
        card && "amby-creative-gallery-card h-full justify-center",
      )}
    >
      <Input
        autoFocus
        value={title}
        maxLength={100}
        disabled={pending}
        aria-label={placeholder}
        placeholder={placeholder}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setNaming(false)
            setError(null)
          }
        }}
        className={card ? "h-10 text-sm" : "h-7 max-w-xs text-xs"}
      />
      {error && <NoticeLine role="alert" text={failed(error)} />}
    </form>
  )
}
