import * as React from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { OPTION_COLORS } from "./option-model"

/** The color of an option as a round swatch that opens the palette. */
export function ColorSwatch({
  color,
  label,
  onChange,
  disabled,
}: {
  color: string
  label: string
  onChange: (hex: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={label}
          title={label}
          className="size-6 shrink-0 rounded-full border border-border/70 outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          style={{ backgroundColor: color }}
        />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-2">
        <div role="listbox" aria-label={label} className="grid grid-cols-5 gap-1.5">
          {OPTION_COLORS.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              role="option"
              aria-selected={candidate.hex === color.toLowerCase()}
              aria-label={candidate.id}
              className={cn(
                "size-6 rounded-full border border-border/70 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                candidate.hex === color.toLowerCase() && "ring-2 ring-primary ring-offset-1",
              )}
              style={{ backgroundColor: candidate.hex }}
              onClick={() => {
                onChange(candidate.hex)
                setOpen(false)
              }}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
