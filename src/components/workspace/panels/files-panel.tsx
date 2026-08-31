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
  Type as TypeIcon,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
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
import { useViewStateStore } from "../use-view-state-store"
import { NewItemModal } from "../new-item-modal"
import type { PanelRenderProps } from "../panel-registry"

type TreeSortKey = "name" | "type" | "created" | "modified"
type TreeSortDirection = "asc" | "desc"

const TREE_SORT_OPTIONS: Array<{
  key: TreeSortKey
  direction: TreeSortDirection
  labelKey: string
  icon: React.ElementType
}> = [
  { key: "name", direction: "asc", labelKey: "filesPanel.sortNameAsc", icon: FileText },
  { key: "name", direction: "desc", labelKey: "filesPanel.sortNameDesc", icon: FileText },
  { key: "type", direction: "asc", labelKey: "filesPanel.sortTypeAsc", icon: TypeIcon },
  { key: "type", direction: "desc", labelKey: "filesPanel.sortTypeDesc", icon: TypeIcon },
  { key: "modified", direction: "desc", labelKey: "filesPanel.sortModifiedDesc", icon: History },
  { key: "modified", direction: "asc", labelKey: "filesPanel.sortModifiedAsc", icon: History },
  { key: "created", direction: "desc", labelKey: "filesPanel.sortCreatedDesc", icon: Clock },
  { key: "created", direction: "asc", labelKey: "filesPanel.sortCreatedAsc", icon: Clock },
]

function sortTreeItems(
  items: TreeItem[],
  key: TreeSortKey,
  direction: TreeSortDirection,
): TreeItem[] {
  const multiplier = direction === "asc" ? 1 : -1
  return items
    .map((item) => ({
      ...item,
      children: item.children ? sortTreeItems(item.children, key, direction) : item.children,
    }))
    .sort((a, b) => {
      const result =
        key === "name"
          ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
          : key === "type"
            ? a.type.localeCompare(b.type)
            : (a[key] ?? 0) - (b[key] ?? 0)
      return result * multiplier || a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
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
    onNewFile,
    onNewFolder,
    onNewCanvas,
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
    linkedLayersByDoc,
    workspaceSwitcher,
  } = props
  const [newItemModalOpen, setNewItemModalOpen] = React.useState(false)
  const closedTreeIds = useViewStateStore((s) => s.closedTreeIds)
  const setTreeExpanded = useViewStateStore((s) => s.setTreeExpanded)
  const allOpen = closedTreeIds.size === 0
  const [findActiveKey, setFindActiveKey] = React.useState(0)
  const [sortKey, setSortKey] = React.useState<TreeSortKey>("name")
  const [sortDirection, setSortDirection] = React.useState<TreeSortDirection>("asc")
  const sortedTreeItems = React.useMemo(
    () => sortTreeItems(treeItems, sortKey, sortDirection),
    [treeItems, sortKey, sortDirection],
  )

  function handleNewButtonClick() {
    if (!vault) {
      onOpenVault()
      return
    }
    setNewItemModalOpen(true)
  }

  function handleToggleFolders() {
    setTreeExpanded(treeItems, !allOpen)
  }

  function handleFindActive() {
    setFindActiveKey((k) => k + 1)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
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
                  {index > 0 && index % 2 === 0 && <DropdownMenuSeparator className="bg-accent" />}
                  <DropdownMenuItem
                    className="relative flex items-center gap-2 pr-9 text-[13px] whitespace-nowrap focus:bg-accent focus:text-white"
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
      </div>

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex flex-1 min-h-0 flex-col">
            {/* SidebarTree owns its own scroll container for virtualizer access */}
            <div className="flex-1 min-h-0">
              {sortedTreeItems.length === 0 ? (
                <p className="px-4 py-3 text-[12px] text-muted-foreground">
                  {t("filesPanel.empty")}
                </p>
              ) : (
                <SidebarTree
                  items={sortedTreeItems}
                  selectedId={selectedId}
                  onSelect={onSelect}
                  onRename={onRename}
                  onDelete={onDelete}
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
                  linkedLayersByDoc={linkedLayersByDoc}
                  findActiveKey={findActiveKey}
                />
              )}
            </div>

            <div className="shrink-0 p-2">
              <Button
                className="w-full gap-2 bg-secondary text-secondary-foreground hover:bg-secondary/80"
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
              else onNewFile?.(null)
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
            disabled
            className="flex items-center gap-2 text-[13px] text-muted-foreground"
          >
            <Database className="size-3.5" />
            {t("filesPanel.database")}
            <span className="ml-auto text-[10px] text-muted-foreground">
              {t("common.comingSoon")}
            </span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <NewItemModal
        open={newItemModalOpen}
        onClose={() => setNewItemModalOpen(false)}
        onCreateNote={() => onNewFile?.(null)}
        onCreateFolder={() => onNewFolder?.(null)}
        onCreateCanvas={() => onNewCanvas?.(null)}
      />
    </div>
  )
}
