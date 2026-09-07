"use client"

import * as React from "react"
import * as SwitchPrimitive from "@radix-ui/react-switch"
import { motion } from "motion/react"

import { motionTransitions } from "@/lib/motion-config"
import { cn } from "@/lib/utils"

function Switch({
  className,
  checked,
  defaultChecked,
  onCheckedChange,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  const [internalChecked, setInternalChecked] = React.useState(defaultChecked ?? false)
  const visualChecked = checked ?? internalChecked

  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer data-[state=checked]:bg-primary data-[state=unchecked]:bg-input focus-visible:border-ring focus-visible:ring-ring/50 dark:data-[state=unchecked]:bg-input/80 inline-flex h-[1.15rem] w-8 shrink-0 items-center rounded-full border border-transparent shadow-xs outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      checked={checked}
      defaultChecked={defaultChecked}
      onCheckedChange={(nextChecked) => {
        setInternalChecked(nextChecked)
        onCheckedChange?.(nextChecked)
      }}
      {...props}
    >
      <SwitchPrimitive.Thumb asChild>
        <motion.span
          data-slot="switch-thumb"
          className="pointer-events-none block size-4 rounded-full bg-background ring-0 dark:data-[state=checked]:bg-primary-foreground dark:data-[state=unchecked]:bg-foreground"
          animate={{ x: visualChecked ? 14 : 0 }}
          transition={motionTransitions.default}
        />
      </SwitchPrimitive.Thumb>
    </SwitchPrimitive.Root>
  )
}

export { Switch }
