"use client"

import * as React from "react"
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area"
import { motion } from "motion/react"

import { motionTransitions } from "@/lib/motion-config"
import { cn } from "@/lib/utils"

const MotionScrollAreaViewport = motion.create(ScrollAreaPrimitive.Viewport)
const MotionScrollAreaScrollbar = motion.create(ScrollAreaPrimitive.ScrollAreaScrollbar)

function ScrollArea({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root>) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <MotionScrollAreaViewport
        data-slot="scroll-area-viewport"
        className="focus-visible:ring-ring/50 size-full rounded-[inherit] outline-none focus-visible:ring-[3px] focus-visible:outline-1"
        transition={motionTransitions.fast}
      >
        {children}
      </MotionScrollAreaViewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <MotionScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        "flex touch-none p-px select-none",
        orientation === "vertical" && "h-full w-2.5 border-l border-l-transparent",
        orientation === "horizontal" && "h-2.5 flex-col border-t border-t-transparent",
        className,
      )}
      transition={motionTransitions.fast}
      {...(props as React.ComponentProps<typeof MotionScrollAreaScrollbar>)}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="bg-border relative flex-1 rounded-full"
      />
    </MotionScrollAreaScrollbar>
  )
}

export { ScrollArea, ScrollBar }
