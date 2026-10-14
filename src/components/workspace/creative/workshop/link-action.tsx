import { Link2 } from "lucide-react"
import { treeIndent } from "./tree-indent"

/**
 * A quiet row that offers to link a section made before the links existed: it adds the
 * "Stories" (or "Universe") relation and records it in the workshop file.
 */
export function LinkAction({
  label,
  title,
  pending = false,
  onClick,
  indent = 1,
}: {
  label: string
  title?: string
  pending?: boolean
  onClick: () => void
  indent?: number
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={pending}
      onClick={onClick}
      style={{ paddingLeft: treeIndent(indent) }}
      className="amby-tree-row flex w-full items-center gap-1.5 rounded py-1 pr-3 text-left text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
    >
      <Link2 aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  )
}
