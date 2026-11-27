import { Archive, Cloud } from "lucide-react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"

/**
 * The switch of the archive header (И9б): two icons in a small pill, archive and cloud, the same
 * look as the note / database switch of a page. Shown only while sync is on.
 */
export function ArchiveViewSwitch({
  cloud,
  onChange,
}: {
  cloud: boolean
  onChange: (cloud: boolean) => void
}) {
  const { t } = useTranslation()
  const items = [
    { cloud: false, label: t("archivePanel.archiveView"), Icon: Archive },
    { cloud: true, label: t("archivePanel.cloudView"), Icon: Cloud },
  ]
  return (
    <div
      role="group"
      aria-label={t("panels.archive")}
      className="flex items-center gap-0.5 rounded-lg border border-border/60 bg-muted/40 p-0.5 shadow-2xs"
    >
      {items.map(({ cloud: target, label, Icon }) => {
        const active = cloud === target
        return (
          <button
            key={label}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={active}
            onClick={() => {
              if (!active) onChange(target)
            }}
            className={cn(
              "flex size-6 cursor-pointer items-center justify-center rounded-md select-none",
              active
                ? "border border-border/80 bg-[var(--note-surface)] text-foreground shadow-xs"
                : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
          </button>
        )
      })}
    </div>
  )
}
