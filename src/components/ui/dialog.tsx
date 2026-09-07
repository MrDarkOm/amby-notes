"use client"

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { XIcon } from "lucide-react"
import { motion } from "motion/react"

import { cn } from "@/lib/utils"
import i18n from "@/lib/i18n"
import { motionTransitions } from "@/lib/motion-config"

const MotionDialogOverlay = motion.create(DialogPrimitive.Overlay)
const MotionDialogContent = motion.create(DialogPrimitive.Content)
const MotionDialogClose = motion.create(DialogPrimitive.Close)

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <MotionDialogOverlay
      data-slot="dialog-overlay"
      className={cn("fixed inset-0 z-50 bg-black/50", className)}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={motionTransitions.enter}
      {...(props as React.ComponentProps<typeof MotionDialogOverlay>)}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
}) {
  const verticalOffset =
    typeof className === "string" && className.includes("translate-y-0") ? 0 : "-50%"

  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <MotionDialogContent
        data-slot="dialog-content"
        className={cn(
          "fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] gap-4 rounded-lg border bg-background p-6 shadow-lg sm:max-w-lg",
          className,
        )}
        initial={{ opacity: 0, scale: 0.95, x: "-50%", y: verticalOffset }}
        animate={{ opacity: 1, scale: 1, x: "-50%", y: verticalOffset }}
        transition={motionTransitions.enter}
        {...(props as React.ComponentProps<typeof MotionDialogContent>)}
      >
        {children}
        {showCloseButton && (
          <MotionDialogClose
            data-slot="dialog-close"
            className="ring-offset-background focus:ring-ring data-[state=open]:bg-accent data-[state=open]:text-muted-foreground absolute top-4 right-4 rounded-xs focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
            initial={{ opacity: 0.7 }}
            whileHover={{ opacity: 1 }}
            transition={motionTransitions.fast}
          >
            <XIcon />
            <span className="sr-only">{i18n.t("common.close")}</span>
          </MotionDialogClose>
        )}
      </MotionDialogContent>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  )
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
