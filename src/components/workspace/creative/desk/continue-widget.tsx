import { Play } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { formatModified } from "../../workspace-tree-utils"

interface ContinueWidgetProps {
  /** The page of this story's text changed last; `null` while there is none. */
  page: { noteId: string; title: string; modified: number | null; words: number } | null
  /** The level's name of that page ("Chapter"), when the schema has one. */
  levelName?: string | null
  loading: boolean
  onOpen: (noteId: string) => void
}

/** Where to continue: the page changed last, how long ago and how long it is, and "Write". */
export function ContinueWidget({ page, levelName, loading, onOpen }: ContinueWidgetProps) {
  const { t } = useTranslation()
  if (!page) {
    return (
      <p className="text-sm text-muted-foreground">
        {loading ? "" : t("creative.page.desk.continueEmpty")}
      </p>
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
      <div className="min-w-0 flex-1 basis-48">
        <p className="break-words text-xl font-semibold leading-snug">{page.title}</p>
        <p className="mt-0.5 break-words text-[13px] text-muted-foreground">
          {[
            levelName,
            page.modified !== null
              ? t("creative.storyCard.edited", { when: formatModified(page.modified) })
              : null,
            t("docEditor.wordCount", { count: page.words }),
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
      <Button onClick={() => onOpen(page.noteId)}>
        <Play className="size-3.5 fill-current" />
        {t("creative.workshopPage.write")}
      </Button>
    </div>
  )
}
