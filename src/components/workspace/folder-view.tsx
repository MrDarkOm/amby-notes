"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { FileText, Folder, FolderPlus, LayoutGrid, Plus, Search } from "lucide-react"
import { cn } from "@/lib/utils"
import { IconValue } from "./icon-value"
import type { TreeItem } from "./sidebar-tree"
import { countFolderContents } from "./folder-view-utils"
import { EmojiPickerPanel } from "./tiptap/EmojiPickerPanel"

interface FolderViewProps {
  folder: TreeItem
  onOpenItem: (id: string) => void
  onNewNote: (parentId: string | null) => void
  onNewFolder: (parentId: string | null) => void
  onIconChange: (icon: string) => void
}

function itemIcon(item: TreeItem) {
  const customIcon = item.icon && !["folder", "file", "canvas", "supernote"].includes(item.icon)
  if (customIcon) return <IconValue value={item.icon} className="size-5" />
  if (item.type === "folder") return <Folder className="size-5" />
  if (item.type === "canvas") return <LayoutGrid className="size-5" />
  return <FileText className="size-5" />
}

export function FolderView({
  folder,
  onOpenItem,
  onNewNote,
  onNewFolder,
  onIconChange,
}: FolderViewProps) {
  const { t, i18n } = useTranslation()
  const [query, setQuery] = React.useState("")
  const [iconPickerOpen, setIconPickerOpen] = React.useState(false)
  const iconTriggerRef = React.useRef<HTMLDivElement>(null)
  const children = React.useMemo(() => folder.children ?? [], [folder.children])
  const counts = React.useMemo(() => countFolderContents(folder), [folder])
  const visibleItems = React.useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase(i18n.language)
    return [...children]
      .filter((item) => item.name.toLocaleLowerCase(i18n.language).includes(normalizedQuery))
      .sort((a, b) => {
        if (a.type === "folder" && b.type !== "folder") return -1
        if (a.type !== "folder" && b.type === "folder") return 1
        return a.name.localeCompare(b.name, i18n.language, { numeric: true })
      })
  }, [children, i18n.language, query])

  React.useEffect(() => setQuery(""), [folder.id])

  return (
    <div className="flex min-h-0 flex-1 overflow-auto bg-[var(--workspace-bg)]">
      <div className="mx-auto flex w-full max-w-5xl flex-col px-8 py-10 md:px-12">
        <header className="mb-8 flex flex-wrap items-start justify-between gap-5">
          <div className="min-w-0">
            <div ref={iconTriggerRef} className="relative mb-3 w-fit">
              <button
                type="button"
                className="flex size-12 items-center justify-center rounded-2xl bg-accent text-foreground transition-transform hover:scale-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                title={t("docEditor.changeIcon")}
                aria-label={t("docEditor.changeIcon")}
                onClick={() => setIconPickerOpen((open) => !open)}
              >
                {folder.icon && !["folder", "file", "canvas", "supernote"].includes(folder.icon) ? (
                  <IconValue value={folder.icon} className="size-7" />
                ) : (
                  <Folder className="size-7 text-amber-500" strokeWidth={1.8} />
                )}
              </button>
              {iconPickerOpen && (
                <div className="absolute left-0 top-full z-50 mt-1">
                  <EmojiPickerPanel
                    triggerRef={iconTriggerRef}
                    onSelect={(icon) => {
                      onIconChange(icon.native)
                      setIconPickerOpen(false)
                    }}
                    onClear={() => {
                      onIconChange("folder")
                      setIconPickerOpen(false)
                    }}
                    clearLabel={t("tree.resetIcon")}
                    onClose={() => setIconPickerOpen(false)}
                  />
                </div>
              )}
            </div>
            <h1 className="truncate text-3xl font-semibold tracking-tight text-foreground">
              {folder.name}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {t("folderView.summary", { notes: counts.notes, folders: counts.folders })}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm text-foreground transition-colors hover:bg-accent"
              onClick={() => onNewFolder(folder.id)}
            >
              <FolderPlus className="size-4" />
              {t("folderView.newFolder")}
            </button>
            <button
              type="button"
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-sm text-primary-foreground transition-opacity hover:opacity-90"
              onClick={() => onNewNote(folder.id)}
            >
              <Plus className="size-4" />
              {t("folderView.newNote")}
            </button>
          </div>
        </header>

        <div className="relative mb-5">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("folderView.search")}
            className="h-10 w-full rounded-xl border border-border bg-card pl-10 pr-4 text-sm text-foreground outline-none transition-shadow placeholder:text-muted-foreground focus:ring-2 focus:ring-ring/40"
          />
        </div>

        {visibleItems.length > 0 ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {visibleItems.map((item) => {
              const nested = item.type === "folder" ? countFolderContents(item) : null
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onOpenItem(item.id)}
                  className="group flex min-h-24 items-start gap-3 rounded-xl border border-border bg-card p-4 text-left transition-[border-color,background-color,transform] hover:-translate-y-0.5 hover:border-ring/40 hover:bg-accent/50"
                >
                  <span
                    className={cn(
                      "flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-muted-foreground group-hover:text-foreground",
                      item.type === "folder" && "text-amber-500",
                    )}
                  >
                    {itemIcon(item)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {item.name.replace(/\.md$/iu, "")}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {nested
                        ? t("folderView.itemSummary", {
                            notes: nested.notes,
                            folders: nested.folders,
                          })
                        : item.type === "canvas"
                          ? t("folderView.canvas")
                          : t("folderView.note")}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        ) : (
          <div className="flex min-h-56 flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card/40 px-6 text-center">
            <Folder className="mb-3 size-8 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">
              {query ? t("folderView.noResults") : t("folderView.empty")}
            </p>
            <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
              {query ? t("folderView.noResultsHint") : t("folderView.emptyHint")}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
