"use client"

import * as React from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"
import { motion } from "motion/react"

import { cn } from "@/lib/utils"
import {
  floatingSurfaceAnimate,
  floatingSurfaceInitial,
  motionTransitions,
} from "@/lib/motion-config"

const MotionPopoverContent = motion.create(PopoverPrimitive.Content)

/** The popovers this popover sits inside (its own id last): nested ones keep their parents open. */
const PopoverChainContext = React.createContext<string[]>([])
/** The popover a trigger, anchor or content belongs to. */
const PopoverOwnContext = React.createContext<{ id: string; chain: string[] } | null>(null)

/** Popovers that are open right now. Opening one closes every other that is not its parent. */
const openPopovers = new Map<string, () => void>()

/** Other floating layers (menus, selects, dialogs, pickers) manage their own dismissal. */
const OTHER_LAYERS =
  "[data-radix-popper-content-wrapper], [role=dialog], [role=alertdialog], [role=menu], [role=listbox], .amby-emoji-picker-panel"

function Popover({
  open,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  const id = React.useId()
  const parentChain = React.useContext(PopoverChainContext)
  const chain = React.useMemo(() => [...parentChain, id], [id, parentChain])
  const [innerOpen, setInnerOpen] = React.useState(defaultOpen ?? false)
  const isOpen = open ?? innerOpen
  const setOpen = (next: boolean) => {
    if (open === undefined) setInnerOpen(next)
    onOpenChange?.(next)
  }
  const closeRef = React.useRef(() => {})
  closeRef.current = () => setOpen(false)

  // Only one popover is open at a time, whatever swallows the click: a press anywhere outside
  // this popover (and the popovers inside it) closes it, and so does another one opening. The
  // press is read in the capture phase, before any handler can stop it.
  React.useEffect(() => {
    if (!isOpen) return
    for (const [otherId, close] of openPopovers) if (!chain.includes(otherId)) close()
    openPopovers.set(id, () => closeRef.current())
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (!target) return
      const hit = target.closest("[data-popover-content]")
      const hitChain = hit?.getAttribute("data-popover-chain")?.split(",") ?? []
      if (hitChain.includes(id)) return
      if (target.closest(`[data-popover-trigger~="${id}"]`)) return
      if (!hit && target.closest(OTHER_LAYERS)) return
      closeRef.current()
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true)
      openPopovers.delete(id)
    }
  }, [chain, id, isOpen])

  return (
    <PopoverOwnContext.Provider value={{ id, chain }}>
      <PopoverPrimitive.Root data-slot="popover" open={isOpen} onOpenChange={setOpen} {...props} />
    </PopoverOwnContext.Provider>
  )
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  const own = React.useContext(PopoverOwnContext)
  return (
    <PopoverPrimitive.Trigger
      data-slot="popover-trigger"
      data-popover-trigger={own?.id}
      {...props}
    />
  )
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  children,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  const own = React.useContext(PopoverOwnContext)
  return (
    <PopoverPrimitive.Portal>
      <MotionPopoverContent
        data-slot="popover-content"
        data-popover-content=""
        data-popover-chain={own?.chain.join(",")}
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-72 origin-(--radix-popover-content-transform-origin) rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-hidden",
          className,
        )}
        initial={floatingSurfaceInitial}
        animate={floatingSurfaceAnimate}
        transition={motionTransitions.enter}
        {...(props as React.ComponentProps<typeof MotionPopoverContent>)}
      >
        <PopoverChainContext.Provider value={own?.chain ?? []}>
          {children as React.ReactNode}
        </PopoverChainContext.Provider>
      </MotionPopoverContent>
    </PopoverPrimitive.Portal>
  )
}

function PopoverAnchor({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  const own = React.useContext(PopoverOwnContext)
  return (
    <PopoverPrimitive.Anchor data-slot="popover-anchor" data-popover-trigger={own?.id} {...props} />
  )
}

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor }
