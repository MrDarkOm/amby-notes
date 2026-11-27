import type { ComponentProps } from "react"
import { useTranslation } from "react-i18next"
import { ItemActionsContext } from "./item-actions"
import { ItemMenu } from "./item-menu"

export function StoryNoteMenu({
  noteId,
  title,
  onOpenNote,
  children,
}: {
  noteId: string | null
  title: string
  onOpenNote?: (noteId: string) => void
  children: ComponentProps<typeof ItemMenu>["children"]
}) {
  const { t } = useTranslation()
  if (!noteId || !onOpenNote) return children
  return (
    <ItemActionsContext.Provider value={{ onOpen: onOpenNote }}>
      <ItemMenu noteId={noteId} title={title} openLabel={t("creative.storyDescription.openNote")}>
        {children}
      </ItemMenu>
    </ItemActionsContext.Provider>
  )
}
