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
        "inline-flex max-w-full items-center gap-1 truncate rounded px-1.5 py-0.5 text-[11px] text-foreground",
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
      className={cn(
        "max-w-full truncate rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground",
        pending && "italic",
      )}
      aria-busy={pending || undefined}
    >
      {chip.label ?? t("databaseValue.loading")}
    </span>
  )
}

/** One property of a card: its name and formatted value chips. */
export function PropertyValue({ property }: { property: DisplayProperty }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      <span className="shrink-0 text-[10px] text-muted-foreground/80">{property.name}</span>
      {property.chips.map((chip) => (
        <ValueChip key={chip.key} chip={chip} />
      ))}
    </span>
  )
}
