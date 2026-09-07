import type { PropsWithChildren } from "react"
import { motion } from "motion/react"

import { cn } from "@/lib/utils"

export function MotionSpinner({ className, children }: PropsWithChildren<{ className?: string }>) {
  return (
    <motion.span
      aria-hidden="true"
      className={cn("inline-flex shrink-0", className)}
      animate={{ rotate: 360 }}
      transition={{ duration: 0.8, ease: "linear", repeat: Infinity }}
    >
      {children}
    </motion.span>
  )
}

export function MotionPulse({ className }: { className?: string }) {
  return (
    <motion.span
      aria-hidden="true"
      className={className}
      animate={{ opacity: [0.45, 1, 0.45], scale: [0.96, 1, 0.96] }}
      transition={{ duration: 1.4, ease: "easeInOut", repeat: Infinity }}
    />
  )
}
