import { useTranslation } from "react-i18next"
import type { SearchSource } from "./workshop-model"

interface SearchResultsProps {
  groups: SearchSource[]
  /** The name of the project that holds a page; a collection's pages are "shared". */
  projectName: (projectId: string) => string
  status: "idle" | "loading" | "ready" | "error"
  error: string | null
  onOpen: (noteId: string) => void
}

/** What the one search found, under the tab each page belongs to. */
export function SearchResults({ groups, projectName, status, error, onOpen }: SearchResultsProps) {
  const { t } = useTranslation()
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
      {status === "error" && (
        <p role="alert" className="px-2 py-3 text-xs text-destructive">
          {t("creative.workshop.loadFailed")}
          {error ? ` ${error}` : ""}
        </p>
      )}
      {status !== "error" && status !== "loading" && groups.length === 0 && (
        <p className="px-2 py-3 text-xs text-muted-foreground">
          {t("creative.workshop.nothingFound")}
        </p>
      )}
      {groups.map((group) => (
        <section key={group.key} className="mb-2">
          <h3 className="flex items-center gap-1.5 px-2 pb-0.5 pt-2 text-[11px] font-medium text-muted-foreground">
            <span className="truncate">{group.label}</span>
            <span className="opacity-60">{group.items.length}</span>
          </h3>
          {group.items.map((item) => (
            <button
              key={item.noteId}
              type="button"
              onClick={() => onOpen(item.noteId)}
              className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent/50"
            >
              <span className="min-w-0 flex-1 truncate">{item.title}</span>
              <span className="ml-2 max-w-24 shrink-0 truncate text-[10px] text-muted-foreground">
                {projectName(item.projectId) || t("creative.workshop.shared")}
              </span>
            </button>
          ))}
        </section>
      ))}
    </div>
  )
}
