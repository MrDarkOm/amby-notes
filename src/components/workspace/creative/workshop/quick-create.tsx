import * as React from "react"
import { Plus } from "lucide-react"
import { Input } from "@/components/ui/input"

interface QuickCreateProps {
  /** The button that opens the field. */
  label: string
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
export function QuickCreate({ label, placeholder, failed, onCreate, describe }: QuickCreateProps) {
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
        className="flex w-fit items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Plus className="size-3.5" />
        {label}
      </button>
    )
  }
  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-1">
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
        className="h-7 max-w-xs text-xs"
      />
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {failed(error)}
        </p>
      )}
    </form>
  )
}
