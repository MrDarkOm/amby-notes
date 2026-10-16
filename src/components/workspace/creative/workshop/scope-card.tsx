import * as React from "react"
import { ArrowRight, ChevronDown } from "lucide-react"
import { motion } from "motion/react"
import {
  AmbySelect,
  type AmbySelectAction,
  type AmbySelectOption,
} from "@/components/ui/amby-select"
import { motionTransition, motionTransitions } from "@/lib/motion-config"

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
  "hidden size-4 group-hover/card:block group-has-[:focus-visible]/card:block group-has-[[aria-expanded=true]]/card:block group-has-[[aria-expanded=true]]/card:rotate-180"

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

  // A split button: one frame, the choice on the left and, while the pointer is over it (or the
  // list is open, or the keyboard is in it), a narrow segment with the arrow that opens the page
  // slides out at the right behind a thin divider. The list opens from the frame's left edge at
  // the frame's whole width.
  const frameRef = React.useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = React.useState(false)
  const [listOpen, setListOpen] = React.useState(false)
  const [keyboard, setKeyboard] = React.useState(false)
  const [listWidth, setListWidth] = React.useState<number | undefined>(undefined)
  const shown = hovered || listOpen || keyboard

  return (
    <div
      ref={frameRef}
      className="group/card flex min-w-0 overflow-hidden rounded-lg border border-border bg-background"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={(event) => {
        const target = event.target
        setKeyboard(target instanceof HTMLElement && target.matches(":focus-visible"))
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setKeyboard(false)
      }}
    >
      <div className="min-w-0 flex-1 hover:bg-accent">
        <AmbySelect
          aria-label={ariaLabel}
          value={value}
          onValueChange={onValueChange}
          options={options}
          variant="bare"
          listClassName="w-[var(--radix-popover-trigger-width)]"
          listWidth={listWidth}
          className="h-auto rounded-none px-3 py-2 hover:bg-transparent"
          // The card draws its own arrow, in the icon's place.
          chevronClassName="hidden"
          onOpenChange={(open) => {
            if (open) setListWidth(frameRef.current?.offsetWidth || undefined)
            setListOpen(open)
          }}
          title={name}
          renderValue={() => face}
          action={action}
        />
      </div>
      <motion.div
        data-shown={shown}
        initial={false}
        animate={{ width: shown ? 36 : 0, opacity: shown ? 1 : 0 }}
        transition={motionTransition(motionTransitions.slow)}
        className="flex shrink-0 overflow-hidden"
      >
        <button
          type="button"
          title={openLabel}
          aria-label={openLabel}
          onClick={onOpen}
          className="flex w-9 shrink-0 items-center justify-center border-l border-border text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <ArrowRight className="size-4" />
        </button>
      </motion.div>
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
