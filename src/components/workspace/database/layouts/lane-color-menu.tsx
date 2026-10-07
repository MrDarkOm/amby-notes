"use client"

import * as React from "react"
import { MoreHorizontal } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { OPTION_COLORS } from "../option-model"

/**
 * The "..." of a board column: pick the column's colour, which is the colour of the
 * option the column stands for (so tags of that option change with it).
 */
export function LaneColorMenu({
  color,
  onChange,
}: {
  color: string | null
  onChange: (hex: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const current = color?.toLowerCase() ?? null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("databaseBoard.laneColor")}
          title={t("databaseBoard.laneColor")}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none hover:bg-background/70 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring group-hover/lane:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontal className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto space-y-2 p-2.5">
        <p className="px-0.5 text-[11px] font-medium text-muted-foreground">
          {t("databaseBoard.laneColor")}
        </p>
        <div
          role="listbox"
          aria-label={t("databaseBoard.laneColor")}
          className="grid grid-cols-5 gap-1.5"
        >
          {OPTION_COLORS.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              role="option"
              aria-selected={candidate.hex === current}
              aria-label={candidate.id}
              className={cn(
                "size-6 rounded-full border border-border/70 outline-none focus-visible:ring-1 focus-visible:ring-ring",
                candidate.hex === current && "ring-2 ring-primary ring-offset-1",
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
