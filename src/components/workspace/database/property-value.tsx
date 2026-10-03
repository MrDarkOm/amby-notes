import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import type { DisplayChip, DisplayProperty } from "./value-format"

/** Option label tinted with the option's own color; neutral without one. */
export function StatusBadge({ chip, className }: { chip: DisplayChip; className?: string }) {
  const { t } = useTranslation()
  const label = chip.label ?? t("databaseValue.unknownOption")
  return (
    <span
      className={cn(
        "inline-flex h-[22px] max-w-full shrink-0 items-center gap-1.5 truncate rounded-md px-2 text-xs font-medium text-foreground",
        chip.color ? undefined : "bg-muted",
        chip.state === "missing" && "italic text-muted-foreground",
        className,
      )}
      style={
        chip.color
          ? { backgroundColor: `color-mix(in srgb, ${chip.color} 22%, transparent)` }
          : undefined
      }
    >
      {chip.color && (
        <span
          aria-hidden="true"
          className="size-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: chip.color }}
        />
      )}
      <span className="truncate">{label}</span>
    </span>
  )
}

function ValueChip({ chip }: { chip: DisplayChip }) {
  const { t } = useTranslation()
  if (chip.kind === "option") return <StatusBadge chip={chip} />
  const pending = chip.state === "pending"
  return (
    <span
      className={cn("max-w-full truncate text-xs text-foreground/80", pending && "italic")}
      aria-busy={pending || undefined}
    >
      {chip.label ?? t("databaseValue.loading")}
    </span>
  )
}

/** One property of a card: just its value; the property's name is the tooltip. */
export function PropertyValue({ property }: { property: DisplayProperty }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1" title={property.name}>
      {property.chips.map((chip) => (
        <ValueChip key={chip.key} chip={chip} />
      ))}
    </span>
  )
}
