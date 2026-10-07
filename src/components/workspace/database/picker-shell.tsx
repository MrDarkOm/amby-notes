import * as React from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { InlinePickersContext } from "./inline-pickers"

/** A picker's trigger and its list: a popover, or in place under the trigger inside a menu. */
export function PickerShell({
  open,
  onOpenChange,
  trigger,
  align = "start",
  side,
  popoverClassName,
  inlineClassName,
  onContentKeyDown,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  trigger?: React.ReactNode
  align?: "start" | "center" | "end"
  side?: "top" | "right" | "bottom" | "left"
  popoverClassName?: string
  inlineClassName?: string
  onContentKeyDown?: (event: React.KeyboardEvent) => void
  children: React.ReactNode
}) {
  const inline = React.useContext(InlinePickersContext)
  if (inline) {
    return (
      <div className="w-full min-w-0">
        {React.isValidElement<{ onClick?: (event: React.MouseEvent) => void }>(trigger)
          ? React.cloneElement(trigger, {
              // What a popover trigger does by itself: its own click handler, then toggle.
              onClick: (event: React.MouseEvent) => {
                trigger.props.onClick?.(event)
                onOpenChange(!open)
              },
            })
          : trigger}
        {open && (
          <div
            className={cn(
              "mt-1 flex max-h-[380px] flex-col overflow-hidden rounded-md border border-border bg-muted/20 p-1",
              inlineClassName,
            )}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              onContentKeyDown?.(event)
              if (event.key === "Escape") {
                event.stopPropagation()
                onOpenChange(false)
              }
            }}
          >
            {children}
          </div>
        )}
      </div>
    )
  }
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {trigger && <PopoverTrigger asChild>{trigger}</PopoverTrigger>}
      <PopoverContent
        align={align}
        side={side}
        collisionPadding={8}
        sideOffset={6}
        className={popoverClassName}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onContentKeyDown}
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}
