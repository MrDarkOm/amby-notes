"use client"

import * as React from "react"
import { fileManagerPlace } from "../show-in-file-manager"
import {
  ArrowDownUp,
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  Clock,
  Database,
  FilePlus,
  FileText,
  FolderOpen,
  FolderPlus,
  History,
  LayoutGrid,
  ListFilter,
  ListOrdered,
  LocateFixed,
  PenLine,
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
import { errorType, logger } from "@/lib/logger"
import { NoticeLine } from "../notices/notice-line"
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
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
import { useTreeFileDrop } from "../tree/use-tree-file-drop"
import { SidebarTree } from "../sidebar-tree"
import {
  TREE_ORDER_STORAGE_PREFIX,
  TREE_SORT_STORAGE_KEY,
  writeManualTreeOrder,
  writeTreeSortSelection,
} from "./tree-view-storage"
import {
  applyManualTreeOrder,
  collectManualTreeOrder,
  reorderTreeItems,
  sortTreeItems,
  type ManualTreeOrder,
  type TreeReorderPosition,
  type TreeSortDirection,
  type TreeSortKey,
} from "../tree-sort"
import {
  TREE_TYPE_KINDS,
  filterTreeByType,
  isTreeTypeKind,
  type TreeTypeKind,
} from "../tree-type-filter"
import { useSettingsStore } from "../use-settings-store"
import { useViewStateStore } from "../use-view-state-store"
import { NewItemModal } from "../new-item-modal"
import type { PanelRenderProps } from "../panel-registry"
import { collectFavoriteItems } from "./favorites-items"
import { FavoritesSection } from "./favorites-section"
import { PanelHeader, PanelSearch } from "./panel-header"
import { PanelSectionHeading } from "./panel-section"

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
  { key: "manual", direction: "asc", labelKey: "filesPanel.sortManual", icon: ListOrdered },
]

const TREE_TYPE_FILTER_STORAGE_KEY = "amby:tree-type-filter"

function readTreeTypeFilter(): TreeTypeKind[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(TREE_TYPE_FILTER_STORAGE_KEY) ?? "[]")
    return Array.isArray(saved) ? saved.filter(isTreeTypeKind) : []
  } catch {
    return []
  }
}

const TYPE_FILTER_LABELS: Record<TreeTypeKind, { key: string; icon: typeof FileText }> = {
  file: { key: "filesPanel.filterNotes", icon: FileText },
  database: { key: "filesPanel.filterDatabases", icon: Database },
  canvas: { key: "filesPanel.filterCanvases", icon: LayoutGrid },
  sketch: { key: "filesPanel.filterSketches", icon: PenLine },
}

function readTreeSortSelection(): { key: TreeSortKey; direction: TreeSortDirection } {
  if (typeof window === "undefined") return { key: "name", direction: "asc" }
  try {
    const saved = JSON.parse(localStorage.getItem(TREE_SORT_STORAGE_KEY) ?? "{}") as {
      key?: string
      direction?: string
    }
    return {
      key:
        saved.key === "manual" ||
        saved.key === "created" ||
        saved.key === "modified" ||
        saved.key === "name"
          ? saved.key
          : "name",
      direction: saved.direction === "desc" ? "desc" : "asc",
    }
  } catch {
    return { key: "name", direction: "asc" }
  }
}

function readManualTreeOrder(vault: string | null): ManualTreeOrder {
  if (!vault || typeof window === "undefined") return {}
  try {
    const saved = JSON.parse(
      localStorage.getItem(`${TREE_ORDER_STORAGE_PREFIX}${vault}`) ?? "{}",
    ) as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(saved).filter(
        ([, value]) => Array.isArray(value) && value.every((id) => typeof id === "string"),
      ),
    ) as ManualTreeOrder
  } catch {
    return {}
  }
}

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
    treeItems: vaultTreeItems,
    fileTreeItems,
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
    onNewSketch,
    onNewDatabase,
    onAttachCanvas,
    onAttachSketch,
    onOpenInNewTab,
    onOpenSplitRight,
    onOpenSplitDown,
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
    databaseRuntimeEnabled,
    linkedLayersByDoc,
    workspaceSwitcher,
    canvasEnabled = true,
    sketchEnabled = true,
    favoritesEnabled = false,
  } = props
  // A module may present the tree differently here; the other panels keep the vault's own.
  const treeItems = fileTreeItems ?? vaultTreeItems
  const canCreateDatabase = Boolean(databaseRuntimeEnabled ?? canCreateDatabaseLayer)
  const [newItemModalOpen, setNewItemModalOpen] = React.useState(false)
  const [databaseDialogOpen, setDatabaseDialogOpen] = React.useState(false)
  const [databaseParentId, setDatabaseParentId] = React.useState<string | null>(null)
  const [databaseName, setDatabaseName] = React.useState("")
  const [databaseNameError, setDatabaseNameError] = React.useState(false)
  const [databaseCreateFailed, setDatabaseCreateFailed] = React.useState(false)
  const closedTreeIds = useViewStateStore((s) => s.closedTreeIds)
  const setTreeExpanded = useViewStateStore((s) => s.setTreeExpanded)
  const allOpen = closedTreeIds.size === 0
  const autoReveal = useSettingsStore((s) => s.prefs.autoRevealFile)
  const setPrefs = useSettingsStore((s) => s.setPrefs)
  const [sortSelection, setSortSelection] = React.useState(readTreeSortSelection)
  const [manualOrder, setManualOrder] = React.useState<ManualTreeOrder>(() =>
    readManualTreeOrder(vault),
  )
  const { key: sortKey, direction: sortDirection } = sortSelection
  const [query, setQuery] = React.useState("")
  const treeDropRef = React.useRef<HTMLDivElement>(null)
  useTreeFileDrop({ containerRef: treeDropRef, vault, treeItems: vaultTreeItems })
  React.useEffect(() => {
    writeTreeSortSelection(sortKey, sortDirection)
  }, [sortKey, sortDirection])
  React.useEffect(() => {
    setManualOrder(readManualTreeOrder(vault))
  }, [vault])
  React.useEffect(() => {
    if (!vault || sortKey !== "manual") return
    writeManualTreeOrder(vault, manualOrder)
  }, [manualOrder, sortKey, vault])
  const [typeFilter, setTypeFilter] = React.useState<TreeTypeKind[]>(readTreeTypeFilter)
  React.useEffect(() => {
    try {
      localStorage.setItem(TREE_TYPE_FILTER_STORAGE_KEY, JSON.stringify(typeFilter))
    } catch {
      // The filter is a convenience; the tree works without remembering it.
    }
  }, [typeFilter])
  // Only the kinds of file whose module is on can be chosen, and only those narrow the tree.
  const availableKinds = React.useMemo(
    () =>
      TREE_TYPE_KINDS.filter(
        (kind) =>
          kind === "file" ||
          (kind === "database" && canCreateDatabase) ||
          (kind === "canvas" && canvasEnabled) ||
          (kind === "sketch" && sketchEnabled),
      ),
    [canCreateDatabase, canvasEnabled, sketchEnabled],
  )
  const activeKinds = React.useMemo(
    () => new Set(typeFilter.filter((kind) => availableKinds.includes(kind))),
    [typeFilter, availableKinds],
  )
  const typeFilteredItems = React.useMemo(
    () => filterTreeByType(treeItems, activeKinds),
    [activeKinds, treeItems],
  )
  const sortedTreeItems = React.useMemo(
    () =>
      sortKey === "manual"
        ? applyManualTreeOrder(typeFilteredItems, manualOrder)
        : sortTreeItems(typeFilteredItems, sortKey, sortDirection),
    [manualOrder, sortDirection, sortKey, typeFilteredItems],
  )
  const visibleTreeItems = React.useMemo(
    () => filterTreeItems(sortedTreeItems, query),
    [query, sortedTreeItems],
  )
  // Favorites come from the vault's whole tree, so a type filter never hides a bookmark.
  const favoriteItems = React.useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    const all = collectFavoriteItems(vaultTreeItems, favorites)
    return normalized
      ? all.filter((item) => item.name.toLocaleLowerCase().includes(normalized))
      : all
  }, [favorites, query, vaultTreeItems])
  const showFavorites = favoritesEnabled && favoriteItems.length > 0

  function handleNewButtonClick() {
    if (!vault) {
      onOpenVault()
      return
    }
    setNewItemModalOpen(true)
  }

  function handleNewDatabaseClick(parentId: string | null = null) {
    if (!vault) {
      onOpenVault()
      return
    }
    setDatabaseParentId(parentId)
    setDatabaseName(t("defaults.untitled"))
    setDatabaseNameError(false)
    setDatabaseCreateFailed(false)
    setDatabaseDialogOpen(true)
  }

  async function handleCreateDatabase(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = databaseName.trim()
    if (!name) {
      setDatabaseNameError(true)
      return
    }
    setDatabaseCreateFailed(false)
    try {
      await onNewDatabase?.(databaseParentId, name)
    } catch (error) {
      // The dialog stays open with an inline error next to the action (notice rules).
      logger.warn("database.create_failed", { errorType: errorType(error) })
      setDatabaseCreateFailed(true)
      return
    }
    setDatabaseDialogOpen(false)
  }

  function handleToggleFolders() {
    setTreeExpanded(treeItems, !allOpen)
  }

  function handleToggleAutoReveal() {
    void setPrefs({ autoRevealFile: !autoReveal })
  }

  const handleReorderItems = React.useCallback(
    (sourceIds: string[], targetId: string | null, position: TreeReorderPosition) => {
      if (sortKey !== "manual") return
      const reorderedTree = reorderTreeItems(sortedTreeItems, sourceIds, targetId, position)
      if (reorderedTree === sortedTreeItems) return
      setManualOrder(collectManualTreeOrder(reorderedTree))
    },
    [sortKey, sortedTreeItems],
  )

  return (
    <div data-help-scope="files" className="flex h-full min-h-0 flex-col">
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
                        setSortSelection({ key, direction })
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="relative size-7 text-muted-foreground hover:bg-accent hover:text-white"
                  title={t("filesPanel.filter")}
                  aria-label={t("filesPanel.filter")}
                >
                  <ListFilter className="size-3.5" />
                  {activeKinds.size > 0 && (
                    <span
                      aria-hidden="true"
                      className="absolute right-1 top-1 size-1.5 rounded-full bg-primary"
                    />
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="w-56 border-border bg-popover text-foreground"
              >
                {availableKinds.map((kind) => {
                  const { key, icon: Icon } = TYPE_FILTER_LABELS[kind]
                  const checked = activeKinds.has(kind)
                  return (
                    <DropdownMenuItem
                      key={kind}
                      className="relative flex items-center gap-2 pr-8 text-[13px] focus:bg-accent focus:text-white"
                      // Several kinds can be chosen in a row, so the menu stays open.
                      onSelect={(event) => {
                        event.preventDefault()
                        setTypeFilter((current) =>
                          current.includes(kind)
                            ? current.filter((entry) => entry !== kind)
                            : [...current, kind],
                        )
                      }}
                    >
                      <Icon className="size-3.5 text-muted-foreground" />
                      <span className="flex-1">{t(key)}</span>
                      {checked && <Check className="absolute right-2 size-3.5 text-primary" />}
                    </DropdownMenuItem>
                  )
                })}
                {activeKinds.size > 0 && (
                  <>
                    <DropdownMenuSeparator className="bg-accent" />
                    <DropdownMenuItem
                      className="text-[13px] focus:bg-accent focus:text-white"
                      onSelect={() => setTypeFilter([])}
                    >
                      {t("filesPanel.filterReset")}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="icon"
              className={`size-7 hover:bg-accent hover:text-white ${
                autoReveal ? "bg-accent text-primary" : "text-muted-foreground"
              }`}
              title={t(autoReveal ? "filesPanel.autoRevealOn" : "filesPanel.autoRevealOff")}
              aria-label={t("filesPanel.autoReveal")}
              aria-pressed={autoReveal}
              onClick={handleToggleAutoReveal}
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
      {showFavorites && (
        <>
          <FavoritesSection
            items={favoriteItems}
            selectedId={selectedId}
            onSelect={onSelect}
            onToggleFavorite={onToggleFavorite}
          />
          <PanelSectionHeading title={t("filesPanel.sectionFiles")} />
        </>
      )}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex flex-1 min-h-0 flex-col">
            {/* SidebarTree owns its own scroll container for virtualizer access */}
            <div ref={treeDropRef} className="flex-1 min-h-0">
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
                  onNewFolder={onNewFolder}
                  onNewSketch={onNewSketch}
                  onNewDatabase={onNewDatabase ? handleNewDatabaseClick : undefined}
                  onAttachCanvas={onAttachCanvas}
                  onAttachSketch={onAttachSketch}
                  onOpenInNewTab={onOpenInNewTab}
                  onOpenSplitRight={onOpenSplitRight}
                  onOpenSplitDown={onOpenSplitDown}
                  onOpenInNewWindow={onOpenInNewWindow}
                  onCloneFile={onCloneFile}
                  onOpenInExplorer={onOpenInExplorer}
                  onMoveItem={onMoveItem}
                  onReorderItems={sortKey === "manual" ? handleReorderItems : undefined}
                  onSetIcon={onSetIcon}
                  triggerRenameId={triggerRenameId}
                  favorites={favorites}
                  onToggleFavorite={onToggleFavorite}
                  onAttachLayer={onAttachLayer}
                  canCreateDatabaseLayer={canCreateDatabaseLayer}
                  linkedLayersByDoc={linkedLayersByDoc}
                  canvasEnabled={canvasEnabled}
                  sketchEnabled={sketchEnabled}
                  autoReveal={autoReveal}
                />
              )}
            </div>

            <div className="shrink-0 p-3">
              <Button
                data-help-target="create"
                className="w-full gap-2 border border-foreground/10 bg-foreground/10 font-medium text-foreground shadow-sm hover:bg-foreground/15 hover:shadow-md active:shadow-sm focus-visible:ring-1 focus-visible:ring-foreground/20"
                whileTap={{ y: 1, scale: 0.99 }}
                onClick={handleNewButtonClick}
              >
                <FilePlus className="size-4" />
                {t("filesPanel.create")}
              </Button>
              {workspaceSwitcher && (
                <div className="mt-2" data-workspace-switcher="">
                  {workspaceSwitcher}
                </div>
              )}
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-72 border-border bg-popover text-foreground">
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
          {canvasEnabled && (
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
          )}
          {sketchEnabled && (
            <ContextMenuItem
              className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
              onSelect={() => {
                if (!vault) onOpenVault()
                else onNewSketch?.(null)
              }}
            >
              <PenLine className="size-3.5 text-muted-foreground" />
              {t("filesPanel.newSketch")}
            </ContextMenuItem>
          )}
          <ContextMenuItem
            disabled={!canCreateDatabase}
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white disabled:opacity-50"
            onSelect={() => handleNewDatabaseClick()}
          >
            <Database className="size-3.5" />
            {t("filesPanel.database")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuSub>
            <ContextMenuSubTrigger className="gap-2 text-[13px]">
              <ArrowDownUp className="size-3.5 text-muted-foreground" />
              {t("filesPanel.sortOrder")}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-80 border-border bg-popover text-foreground">
              <ContextMenuRadioGroup
                value={`${sortKey}:${sortDirection}`}
                onValueChange={(value) => {
                  const option = TREE_SORT_OPTIONS.find(
                    ({ key, direction }) => `${key}:${direction}` === value,
                  )
                  if (option) setSortSelection({ key: option.key, direction: option.direction })
                }}
              >
                {TREE_SORT_OPTIONS.map(({ key, direction, labelKey, icon: Icon }, index) => (
                  <React.Fragment key={`${key}:${direction}`}>
                    {index > 0 && index % 2 === 0 && <ContextMenuSeparator />}
                    <ContextMenuRadioItem
                      value={`${key}:${direction}`}
                      className="items-start text-[13px] whitespace-normal break-words"
                    >
                      <Icon className="size-3.5 text-muted-foreground" />
                      {t(labelKey)}
                    </ContextMenuRadioItem>
                  </React.Fragment>
                ))}
              </ContextMenuRadioGroup>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSub>
            <ContextMenuSubTrigger className="gap-2 text-[13px]">
              <ListFilter className="size-3.5 text-muted-foreground" />
              {t("filesPanel.filter")}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-56 border-border bg-popover text-foreground">
              {availableKinds.map((kind) => {
                const { key, icon: Icon } = TYPE_FILTER_LABELS[kind]
                return (
                  <ContextMenuCheckboxItem
                    key={kind}
                    checked={activeKinds.has(kind)}
                    indicatorPosition="right"
                    className="text-[13px]"
                    onSelect={(event) => event.preventDefault()}
                    onCheckedChange={(checked) => {
                      setTypeFilter((current) =>
                        checked
                          ? [...current.filter((entry) => entry !== kind), kind]
                          : current.filter((entry) => entry !== kind),
                      )
                    }}
                  >
                    <Icon className="size-3.5 text-muted-foreground" />
                    {t(key)}
                  </ContextMenuCheckboxItem>
                )
              })}
              {activeKinds.size > 0 && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem className="text-[13px]" onSelect={() => setTypeFilter([])}>
                    {t("filesPanel.filterReset")}
                  </ContextMenuItem>
                </>
              )}
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuCheckboxItem
            checked={autoReveal}
            indicatorPosition="right"
            className="text-[13px]"
            onCheckedChange={handleToggleAutoReveal}
          >
            <LocateFixed className="size-3.5 text-muted-foreground" />
            {t("filesPanel.autoReveal")}
          </ContextMenuCheckboxItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={!vault || treeItems.length === 0}
            className="text-[13px]"
            onSelect={() => setTreeExpanded(treeItems, true)}
          >
            <ChevronsUpDown className="size-3.5 text-muted-foreground" />
            {t("filesPanel.expandAll")}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!vault || treeItems.length === 0}
            className="text-[13px]"
            onSelect={() => setTreeExpanded(treeItems, false)}
          >
            <ChevronsDownUp className="size-3.5 text-muted-foreground" />
            {t("filesPanel.collapseAll")}
          </ContextMenuItem>
          {vault && onOpenInExplorer && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem className="text-[13px]" onSelect={() => onOpenInExplorer(vault)}>
                <FolderOpen className="size-3.5 text-muted-foreground" />
                {t("tree.showInExplorer", { place: fileManagerPlace() })}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      <NewItemModal
        open={newItemModalOpen}
        onClose={() => setNewItemModalOpen(false)}
        onCreateNote={() => onNewFile?.(null)}
        onCreateFolder={() => onNewFolder?.(null)}
        onCreateCanvas={() => onNewCanvas?.(null)}
        onCreateSketch={() => onNewSketch?.(null)}
        onCreateDatabase={handleNewDatabaseClick}
        canCreateDatabase={canCreateDatabase}
        canvasEnabled={canvasEnabled}
        sketchEnabled={sketchEnabled}
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
                // The default name is selected, so typing replaces it.
                onFocus={(event) => event.currentTarget.select()}
                value={databaseName}
                onChange={(event) => {
                  setDatabaseName(event.target.value)
                  setDatabaseNameError(false)
                  setDatabaseCreateFailed(false)
                }}
                placeholder={t("newItem.databaseNamePlaceholder")}
                aria-invalid={databaseNameError}
              />
              {databaseNameError && (
                <p className="text-xs text-destructive">{t("newItem.databaseNameRequired")}</p>
              )}
              {databaseCreateFailed && (
                <NoticeLine role="alert" text={t("newItem.databaseCreateFailed")} />
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
