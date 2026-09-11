"use client"

import * as React from "react"
import {
  ArrowDownUp,
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  Clock,
  Database,
  FilePlus,
  FileText,
  FolderPlus,
  History,
  LayoutGrid,
  LocateFixed,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { TreeItem } from "@/lib/storage"
import { SidebarTree } from "../sidebar-tree"
import { sortTreeItems, type TreeSortDirection, type TreeSortKey } from "../tree-sort"
import { useViewStateStore } from "../use-view-state-store"
import { NewItemModal } from "../new-item-modal"
import type { PanelRenderProps } from "../panel-registry"
import { PanelHeader, PanelSearch } from "./panel-header"

const TREE_SORT_OPTIONS: Array<{
  key: TreeSortKey
  direction: TreeSortDirection
  labelKey: string
  icon: React.ElementType
}> = [
  { key: "name", direction: "asc", labelKey: "filesPanel.sortNameAsc", icon: FileText },
  { key: "name", direction: "desc", labelKey: "filesPanel.sortNameDesc", icon: FileText },
  { key: "modified", direction: "desc", labelKey: "filesPanel.sortModifiedDesc", icon: History },
  { key: "modified", direction: "asc", labelKey: "filesPanel.sortModifiedAsc", icon: History },
  { key: "created", direction: "desc", labelKey: "filesPanel.sortCreatedDesc", icon: Clock },
  { key: "created", direction: "asc", labelKey: "filesPanel.sortCreatedAsc", icon: Clock },
]

function filterTreeItems(items: TreeItem[], query: string): TreeItem[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return items
  return items.flatMap((item) => {
    const children = item.children ? filterTreeItems(item.children, normalized) : []
    const matches = item.name.toLocaleLowerCase().includes(normalized)
    if (!matches && children.length === 0) return []
    return [{ ...item, children: item.children ? children : item.children }]
  })
}

export function FilesPanel(props: PanelRenderProps) {
  const { t } = useTranslation()
  const {
    treeItems,
    selectedId,
    vault,
    onSelect,
    onOpenVault,
    onRename,
    onDelete,
    onDeleteMany,
    onNewFile,
    onNewFolder,
    onNewCanvas,
    onNewDatabase,
    onAttachCanvas,
    onOpenInNewTab,
    onOpenInNewWindow,
    onCloneFile,
    onOpenInExplorer,
    onMoveItem,
    onSetIcon,
    triggerRenameId,
    favorites,
    onToggleFavorite,
    onAttachLayer,
    canCreateDatabaseLayer,
    linkedLayersByDoc,
    workspaceSwitcher,
  } = props
  const [newItemModalOpen, setNewItemModalOpen] = React.useState(false)
  const [databaseDialogOpen, setDatabaseDialogOpen] = React.useState(false)
  const [databaseName, setDatabaseName] = React.useState("")
  const [databaseNameError, setDatabaseNameError] = React.useState(false)
  const closedTreeIds = useViewStateStore((s) => s.closedTreeIds)
  const setTreeExpanded = useViewStateStore((s) => s.setTreeExpanded)
  const allOpen = closedTreeIds.size === 0
  const [findActiveKey, setFindActiveKey] = React.useState(0)
  const [sortKey, setSortKey] = React.useState<TreeSortKey>("name")
  const [sortDirection, setSortDirection] = React.useState<TreeSortDirection>("asc")
  const [query, setQuery] = React.useState("")
  React.useEffect(() => {
    localStorage.setItem(
      "amby:tree-sort",
      JSON.stringify({ key: sortKey, direction: sortDirection }),
    )
  }, [sortKey, sortDirection])
  const sortedTreeItems = React.useMemo(
    () => sortTreeItems(treeItems, sortKey, sortDirection),
    [treeItems, sortKey, sortDirection],
  )
  const visibleTreeItems = React.useMemo(
    () => filterTreeItems(sortedTreeItems, query),
    [query, sortedTreeItems],
  )

  function handleNewButtonClick() {
    if (!vault) {
      onOpenVault()
      return
    }
    setNewItemModalOpen(true)
  }

  function handleNewDatabaseClick() {
    if (!vault) {
      onOpenVault()
      return
    }
    setDatabaseName(t("defaults.untitled"))
    setDatabaseNameError(false)
    setDatabaseDialogOpen(true)
  }

  async function handleCreateDatabase(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = databaseName.trim()
    if (!name) {
      setDatabaseNameError(true)
      return
    }
    await onNewDatabase?.(null, name)
    setDatabaseDialogOpen(false)
  }

  function handleToggleFolders() {
    setTreeExpanded(treeItems, !allOpen)
  }

  function handleFindActive() {
    setFindActiveKey((k) => k + 1)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        hideTitle
        title={t("panels.files")}
        actions={
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:bg-accent hover:text-white"
              title={t("filesPanel.create")}
              onClick={handleNewButtonClick}
            >
              <FilePlus className="size-3.5" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground hover:bg-accent hover:text-white"
                  title={t("filesPanel.sortOrder")}
                >
                  <ArrowDownUp className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="w-80 border-border bg-popover text-foreground"
              >
                {TREE_SORT_OPTIONS.map(({ key, direction, labelKey, icon: Icon }, index) => (
                  <React.Fragment key={`${key}:${direction}`}>
                    {index > 0 && index % 2 === 0 && (
                      <DropdownMenuSeparator className="bg-accent" />
                    )}
                    <DropdownMenuItem
                      className="relative flex items-start gap-2 pr-9 text-[13px] whitespace-normal break-words focus:bg-accent focus:text-white"
                      onSelect={() => {
                        setSortKey(key)
                        setSortDirection(direction)
                      }}
                    >
                      <Icon className="size-3.5 text-muted-foreground" />
                      <span className="flex-1">{t(labelKey)}</span>
                      {sortKey === key && sortDirection === direction && (
                        <Check className="absolute right-2 size-3.5 text-primary" />
                      )}
                    </DropdownMenuItem>
                  </React.Fragment>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:bg-accent hover:text-white"
              title={t("filesPanel.findActive")}
              onClick={handleFindActive}
            >
              <LocateFixed className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:bg-accent hover:text-white"
              title={allOpen ? t("filesPanel.collapseAll") : t("filesPanel.expandAll")}
              onClick={handleToggleFolders}
            >
              {allOpen ? (
                <ChevronsDownUp className="size-3.5" />
              ) : (
                <ChevronsUpDown className="size-3.5" />
              )}
            </Button>
          </div>
        }
      />
      <PanelSearch
        value={query}
        onChange={setQuery}
        ariaLabel={t("filesPanel.search")}
        placeholder={t("filesPanel.search")}
      />
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex flex-1 min-h-0 flex-col">
            {/* SidebarTree owns its own scroll container for virtualizer access */}
            <div className="flex-1 min-h-0">
              {visibleTreeItems.length === 0 ? (
                <p className="px-4 py-3 text-[12px] text-muted-foreground">
                  {query.trim() ? t("filesPanel.noResults") : t("filesPanel.empty")}
                </p>
              ) : (
                <SidebarTree
                  items={visibleTreeItems}
                  selectedId={selectedId}
                  onSelect={onSelect}
                  onRename={onRename}
                  onDelete={onDelete}
                  onDeleteMany={onDeleteMany}
                  onNewFile={onNewFile}
                  onAttachCanvas={onAttachCanvas}
                  onOpenInNewTab={onOpenInNewTab}
                  onOpenInNewWindow={onOpenInNewWindow}
                  onCloneFile={onCloneFile}
                  onOpenInExplorer={onOpenInExplorer}
                  onMoveItem={onMoveItem}
                  onSetIcon={onSetIcon}
                  triggerRenameId={triggerRenameId}
                  favorites={favorites}
                  onToggleFavorite={onToggleFavorite}
                  onAttachLayer={onAttachLayer}
                  canCreateDatabaseLayer={canCreateDatabaseLayer}
                  linkedLayersByDoc={linkedLayersByDoc}
                  findActiveKey={findActiveKey}
                />
              )}
            </div>

            <div className="shrink-0 p-2">
              <Button
                className="w-full gap-2 border border-foreground/10 bg-foreground/10 font-medium text-foreground shadow-sm hover:bg-foreground/15 hover:shadow-md active:shadow-sm focus-visible:ring-2 focus-visible:ring-foreground/20"
                whileTap={{ y: 1, scale: 0.99 }}
                onClick={handleNewButtonClick}
              >
                <FilePlus className="size-4" />
                {t("filesPanel.create")}
              </Button>
              {workspaceSwitcher && <div className="mt-2">{workspaceSwitcher}</div>}
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52 border-border bg-popover text-foreground">
          <ContextMenuItem
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
            onSelect={() => {
              if (!vault) onOpenVault()
              else window.setTimeout(() => void onNewFile?.(null), 80)
            }}
          >
            <FileText className="size-3.5 text-muted-foreground" />
            {t("filesPanel.newNote")}
          </ContextMenuItem>
          <ContextMenuItem
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
            onSelect={() => {
              if (!vault) onOpenVault()
              else onNewFolder?.(null)
            }}
          >
            <FolderPlus className="size-3.5 text-muted-foreground" />
            {t("filesPanel.newFolder")}
          </ContextMenuItem>
          <ContextMenuItem
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
            onSelect={() => {
              if (!vault) onOpenVault()
              else onNewCanvas?.(null)
            }}
          >
            <LayoutGrid className="size-3.5 text-muted-foreground" />
            {t("filesPanel.newCanvas")}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!canCreateDatabaseLayer}
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white disabled:opacity-50"
            onSelect={handleNewDatabaseClick}
          >
            <Database className="size-3.5" />
            {t("filesPanel.database")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <NewItemModal
        open={newItemModalOpen}
        onClose={() => setNewItemModalOpen(false)}
        onCreateNote={() => onNewFile?.(null)}
        onCreateFolder={() => onNewFolder?.(null)}
        onCreateCanvas={() => onNewCanvas?.(null)}
        onCreateDatabase={handleNewDatabaseClick}
        canCreateDatabase={canCreateDatabaseLayer}
      />

      <Dialog open={databaseDialogOpen} onOpenChange={setDatabaseDialogOpen}>
        <DialogContent className="max-w-sm border-border bg-background text-foreground">
          <DialogHeader>
            <DialogTitle>{t("newItem.databaseTitle")}</DialogTitle>
            <DialogDescription>{t("newItem.databaseDescription")}</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreateDatabase} className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="new-database-name" className="text-sm font-medium">
                {t("newItem.databaseName")}
              </label>
              <Input
                id="new-database-name"
                autoFocus
                value={databaseName}
                onChange={(event) => {
                  setDatabaseName(event.target.value)
                  setDatabaseNameError(false)
                }}
                placeholder={t("newItem.databaseNamePlaceholder")}
                aria-invalid={databaseNameError}
              />
              {databaseNameError && (
                <p className="text-xs text-destructive">{t("newItem.databaseNameRequired")}</p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDatabaseDialogOpen(false)}>
                {t("newItem.cancel")}
              </Button>
              <Button type="submit">{t("newItem.createDatabase")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
