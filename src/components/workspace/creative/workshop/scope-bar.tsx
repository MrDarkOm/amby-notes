import * as React from "react"
import { ArrowRight } from "lucide-react"
import {
  AmbySelect,
  type AmbySelectAction,
  type AmbySelectOption,
} from "@/components/ui/amby-select"

/** One drop-down of the bar: what it chooses among, and the choice made. */
export interface ScopeSegment {
  /** The name of the drop-down for assistive tools. */
  ariaLabel: string
  icon: React.ReactNode
  name: string
  /** A quiet note after the name; it wraps under it when the row is narrow. */
  meta?: string | null
  value: string
  options: AmbySelectOption[]
  onValueChange: (value: string) => void
  /** The last item of the list, which acts instead of choosing ("New story"). */
  action?: AmbySelectAction
  /** The small button after it, shown while the bar is hovered: opens the page of the choice. */
  open?: { label: string; onOpen: () => void }
}

interface ScopeBarProps {
  /** The universe the lists are shown in; none leaves only the story. */
  universe?: ScopeSegment | null
  /** The story; `null` shows `prompt` in its place (a scope with no story). */
  story: ScopeSegment | null
  prompt?: { name: string; onClick: () => void }
  /** A row under the choice, inside the same frame ("Continue: …"). */
  footer?: React.ReactNode
}

function OpenButton({
  open,
  clear,
}: {
  open: NonNullable<ScopeSegment["open"]>
  /** The select's own arrow sits at the right end of the row: the button stands left of it. */
  clear: boolean
}) {
  return (
    <button
      type="button"
      title={open.label}
      aria-label={open.label}
      onClick={open.onOpen}
      // Over the row: it takes no width from the name.
      className={`absolute top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md bg-background text-muted-foreground opacity-0 outline-none hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring group-hover/bar:opacity-100 ${clear ? "right-6" : "right-0"}`}
    >
      <ArrowRight className="size-3.5" />
    </button>
  )
}

/** The universe is a small grey line over the story: its arrow follows the name, not the row's end. */
function Segment({ segment, small = false }: { segment: ScopeSegment; small?: boolean }) {
  return (
    <div className="relative min-w-0">
      <AmbySelect
        aria-label={segment.ariaLabel}
        value={segment.value}
        onValueChange={segment.onValueChange}
        options={segment.options}
        action={segment.action}
        variant="bare"
        size="sm"
        title={segment.name}
        className={
          small
            ? "h-auto min-h-5 w-auto max-w-full justify-start gap-0.5 px-1 py-0.5"
            : "h-auto min-h-7 px-1 py-1"
        }
        renderValue={() => (
          <>
            <span
              className={`mr-1.5 flex shrink-0 text-muted-foreground ${small ? "[&_svg]:size-3.5" : "[&_svg]:size-4"}`}
            >
              {segment.icon}
            </span>
            <span
              className={
                small
                  ? "min-w-0 break-words text-xs text-muted-foreground"
                  : "min-w-0 break-words text-[14px] font-medium text-foreground"
              }
            >
              {segment.name}
              {segment.meta ? (
                <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
                  {segment.meta}
                </span>
              ) : null}
            </span>
          </>
        )}
      />
      {segment.open ? <OpenButton open={segment.open} clear={!small} /> : null}
    </div>
  )
}

/**
 * The top of the panel: where the lists below are looking, as one card — the universe as a small
 * grey line over the story, then a line to go on from. Each choice has a small button, shown on
 * hover, that opens its page.
 */
export function ScopeBar({ universe, story, prompt, footer }: ScopeBarProps) {
  return (
    <div
      data-scope-bar=""
      className="group/bar min-w-0 overflow-hidden rounded-lg border border-border bg-background"
    >
      <div className="min-w-0 px-1.5 py-1">
        {universe && <Segment segment={universe} small />}
        {story ? (
          <Segment segment={story} />
        ) : prompt ? (
          <button
            type="button"
            onClick={prompt.onClick}
            className="flex min-h-7 w-full min-w-0 items-center rounded-md px-1 py-1 text-left text-[14px] font-medium outline-none hover:bg-accent/50 focus-visible:ring-1 focus-visible:ring-ring"
          >
            <span className="break-words">{prompt.name}</span>
          </button>
        ) : null}
      </div>
      {footer ? <div className="border-t border-border/60">{footer}</div> : null}
    </div>
  )
}
