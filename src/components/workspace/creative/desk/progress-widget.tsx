import { NotebookPen } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"

export type CompileState =
  | { status: "idle" }
  | { status: "working" }
  | { status: "done"; pages: number; path: string }
  | { status: "failed"; message: string }

interface ProgressWidgetProps {
  pages: number
  words: number
  /** Pages by their status group; `null` when the story keeps no page status. */
  groups: { done: number; inProgress: number } | null
  /** Offered only with a vault to read the pages from. */
  onCompile: (() => void) | null
  compile: CompileState
}

/**
 * How far the story is: pages done of all, a bar in two parts (done, in progress), the words, and
 * "Compile manuscript", which only reads the pages and writes one new file.
 */
export function ProgressWidget({ pages, words, groups, onCompile, compile }: ProgressWidgetProps) {
  const { t } = useTranslation()
  const percent = (count: number) => (pages > 0 ? Math.round((count / pages) * 100) : 0)
  return (
    <div className="flex flex-col gap-2.5">
      {groups ? (
        <>
          <p className="text-2xl font-bold">
            {t("creative.page.desk.doneOf", { done: groups.done, total: pages })}
          </p>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent(groups.done)}
            aria-label={t("creative.storyCard.progress")}
            className="flex h-2 w-full overflow-hidden rounded-full bg-accent"
          >
            <span className="h-full bg-teal-500" style={{ width: `${percent(groups.done)}%` }} />
            <span
              className="h-full bg-primary/40"
              style={{ width: `${percent(groups.inProgress)}%` }}
            />
          </div>
        </>
      ) : (
        <p className="text-2xl font-bold">{t("creative.page.desk.pagesOf", { count: pages })}</p>
      )}
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
        {groups && (
          <span>
            {t("creative.desk.inProgress")}:{" "}
            <b className="font-semibold text-foreground">{groups.inProgress}</b>
          </span>
        )}
        <span>
          {t("creative.page.desk.words")}:{" "}
          <b className="font-semibold text-foreground">{words.toLocaleString()}</b>
        </span>
      </p>
      {onCompile && (
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          title={t("creative.page.desk.manuscriptHint")}
          disabled={compile.status === "working" || pages === 0}
          onClick={onCompile}
        >
          <NotebookPen className="size-3.5" />
          {compile.status === "working"
            ? t("creative.page.desk.compiling")
            : t("creative.page.desk.compile")}
        </Button>
      )}
      {compile.status === "done" && (
        <p role="status" className="break-words text-xs text-muted-foreground">
          {t("creative.page.desk.compiled", { pages: compile.pages, path: compile.path })}
        </p>
      )}
      {compile.status === "failed" && (
        <p role="alert" className="break-words text-xs text-destructive">
          {t("creative.page.desk.compileFailed", { message: compile.message })}
        </p>
      )}
    </div>
  )
}
