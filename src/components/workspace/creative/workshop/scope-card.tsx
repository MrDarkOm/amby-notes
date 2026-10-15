import type * as React from "react"
import { ChevronDown, ExternalLink } from "lucide-react"
import {
  AmbySelect,
  type AmbySelectAction,
  type AmbySelectOption,
} from "@/components/ui/amby-select"
import { Button } from "@/components/ui/button"

interface ScopeCardProps {
  /** The quiet caption in capitals: what the list chooses among ("Stories", "Universes"). */
  label: string
  /** The name of the drop-down for assistive tools. */
  ariaLabel: string
  icon: React.ReactNode
  /** The choice made; a long one wraps instead of ending in an ellipsis. */
  name: string
  /** A quiet note after the caption on the same line; none hides it. */
  meta?: string | null
  value: string
  options: AmbySelectOption[]
  onValueChange: (value: string) => void
  /** The last item of the list, which acts instead of choosing ("New story"). */
  action?: AmbySelectAction
  /** The small button at the right: opens the page of the choice. */
  openLabel: string
  onOpen: () => void
}

/** The arrow takes the icon's place while the card is hovered, keyboard-focused or open. */
const SHOWN_ICON =
  "flex group-hover/card:hidden group-has-[:focus-visible]/card:hidden group-has-[[aria-expanded=true]]/card:hidden"
const SHOWN_ARROW =
  "hidden size-4 group-hover/card:block group-has-[:focus-visible]/card:block group-has-[[aria-expanded=true]]/card:block"

/**
 * One of the two cards of the panel, one shape for both: the stories above the lists and the
 * universes below them. It is the card of the workspace switcher: a bordered card with a plain
 * icon that gives way to the arrow while hovered, a caption over the choice on one line, and a
 * button at the right that opens the page of the choice. The list opens from the whole card and is
 * as wide as it.
 */
export function ScopeCard({
  label,
  ariaLabel,
  icon,
  name,
  meta = null,
  value,
  options,
  onValueChange,
  action,
  openLabel,
  onOpen,
}: ScopeCardProps) {
  const face = (
    <>
      <span className="relative flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
        <span className={SHOWN_ICON}>{icon}</span>
        <ChevronDown aria-hidden="true" className={SHOWN_ARROW} />
      </span>
      <span className="ml-2 min-w-0 flex-1 text-left leading-tight">
        <span className="flex items-baseline gap-1.5 text-muted-foreground">
          <span className="whitespace-nowrap text-[8px] font-medium uppercase tracking-[0.12em]">
            {label}
          </span>
          {meta ? <span className="min-w-0 break-words text-[10px]">{meta}</span> : null}
        </span>
        <span className="block break-words text-[13px] font-medium text-foreground">{name}</span>
      </span>
    </>
  )

  // The control fills the whole card and the open button lies over its right end, so the list
  // opens from the card and is as wide as it with no separate anchor element.
  return (
    <div className="group/card relative rounded-lg border border-border bg-background/70 hover:bg-accent">
      <AmbySelect
        aria-label={ariaLabel}
        value={value}
        onValueChange={onValueChange}
        options={options}
        variant="bare"
        listClassName="w-[var(--radix-popover-trigger-width)]"
        className="h-auto rounded-lg py-2 pl-3 pr-11 hover:bg-transparent"
        // The card draws its own arrow, in the icon's place.
        chevronClassName="hidden"
        title={name}
        renderValue={() => face}
        action={action}
      />
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        title={openLabel}
        aria-label={openLabel}
        onClick={onOpen}
      >
        <ExternalLink className="size-4" />
      </Button>
    </div>
  )
}

/**
 * The card of a list that is still empty: instead of a drop-down with nothing to choose, one
 * button in the same shape that makes the first item ("Create the first story").
 */
export function ScopePrompt({
  label,
  icon,
  name,
  onClick,
}: {
  label: string
  icon: React.ReactNode
  name: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg border border-border bg-background/70 px-3 py-2 text-left outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring"
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block whitespace-nowrap text-[8px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {label}
        </span>
        <span className="block break-words text-[13px] font-medium text-foreground">{name}</span>
      </span>
    </button>
  )
}
