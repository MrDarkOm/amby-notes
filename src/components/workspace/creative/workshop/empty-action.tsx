import { Plus } from "lucide-react"
import { treeIndent } from "./tree-indent"

/**
 * An empty list that offers what to do in it, as a row you can press or reach with the keyboard:
 * it starts the same naming row as the "+" of the part.
 */
export function EmptyAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ paddingLeft: treeIndent(1) }}
      className="amby-tree-row flex w-full min-w-0 items-start gap-1.5 rounded py-1 pr-3 text-left text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <Plus aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 break-words">{label}</span>
    </button>
  )
}
