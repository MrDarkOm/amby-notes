import { FileText } from "lucide-react"
import { IconValue } from "@/components/workspace/icon-value"
import { useViewStateStore } from "@/components/workspace/use-view-state-store"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import { IconPickerButton } from "./icon-picker-button"

/**
 * The page's own icon, or the default page icon when it has none. With `editable`
 * the icon is a button that opens the picker and changes the page's icon.
 */
export function PageIcon({
  noteId,
  className,
  editable = false,
}: {
  noteId: string
  className?: string
  editable?: boolean
}) {
  const { t } = useTranslation()
  const icon = useViewStateStore((state) => state.iconOverrides[noteId])
  const setIcon = useViewStateStore((state) => state.setIcon)
  const fallback = (
    <FileText
      aria-hidden="true"
      className={cn("size-4 shrink-0 text-muted-foreground", className)}
    />
  )
  if (editable) {
    return (
      <IconPickerButton
        value={icon}
        fallback={fallback}
        label={t("databaseCard.changeIcon")}
        onChange={(next) => setIcon(noteId, next)}
        className="size-6"
        iconClassName={cn("size-4 shrink-0", className)}
      />
    )
  }
  return <IconValue value={icon} fallback={fallback} className={cn("size-4 shrink-0", className)} />
}
