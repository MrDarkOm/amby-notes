import { FileText, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { IconValue } from "@/components/workspace/icon-value"
import { cn } from "@/lib/utils"
import type { ReferenceView } from "./use-record-references"

interface RelationChipProps {
  view: ReferenceView
  icon?: string | null
  /** Opening the page and removing the link are separate actions. */
  onOpen?: () => void
  onUnlink?: () => void
  className?: string
}

/** A linked page: icon and title, or an explicit loading/unavailable/error state. */
export function RelationChip({ view, icon, onOpen, onUnlink, className }: RelationChipProps) {
  const { t } = useTranslation()
  const ok = view.status === "ok"
  const label =
    view.status === "ok"
      ? view.title || t("editor.untitled")
      : view.status === "loading"
        ? t("databaseWorkspace.relationChipLoading")
        : view.status === "missing"
          ? t("databaseWorkspace.relationChipMissing")
          : t("databaseWorkspace.relationChipError")
  const unlinkLabel = ok
    ? t("databaseWorkspace.relationUnlinkNamed", { title: label })
    : t("databaseWorkspace.relationUnlinkUnavailable")
  const body = (
    <>
      <IconValue
        value={ok ? (icon ?? undefined) : undefined}
        fallback={<FileText className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />}
        className="size-3 shrink-0"
      />
      <span className="max-w-[130px] truncate font-medium">{label}</span>
    </>
  )
  return (
    <span
      className={cn(
        "inline-flex h-[22px] max-w-full shrink-0 items-center gap-0.5 rounded-md bg-muted/80 pl-2 text-xs text-foreground",
        view.status !== "ok" && "italic text-muted-foreground",
        view.status === "error" && "text-destructive",
        className,
      )}
      title={view.status === "error" ? view.message : label}
      aria-busy={view.status === "loading" || undefined}
    >
      {ok && onOpen ? (
        <button
          type="button"
          className="inline-flex min-w-0 items-center gap-1 py-0.5 hover:underline focus-visible:underline focus-visible:outline-none"
          aria-label={t("databaseWorkspace.relationOpenNamed", { title: label })}
          onClick={(event) => {
            event.stopPropagation()
            onOpen()
          }}
        >
          {body}
        </button>
      ) : (
        <span className="inline-flex min-w-0 items-center gap-1 py-0.5">{body}</span>
      )}
      {onUnlink ? (
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-background/80 hover:text-destructive focus-visible:text-destructive focus-visible:outline-none"
          aria-label={unlinkLabel}
          title={t("databaseWorkspace.relationRemoveItem")}
          onClick={(event) => {
            event.stopPropagation()
            onUnlink()
          }}
        >
          <X className="size-2.5" aria-hidden="true" />
        </button>
      ) : (
        <span className="pr-1.5" />
      )}
    </span>
  )
}
