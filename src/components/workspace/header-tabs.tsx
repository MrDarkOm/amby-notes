"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  Bookmark,
  BookmarkCheck,
  ChevronDown,
  Columns2,
  Minus,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  X,
} from "lucide-react"

const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)
import { cn } from "@/lib/utils"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { isTauri } from "@/lib/storage"
import { WorkspacePicker, type VaultRecord } from "./workspace-picker"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export interface HeaderTab {
  key: string
  fileId: string
  title: string
}

interface HeaderTabsProps {
  tabs: HeaderTab[]
  activeTabKey: string
  unsavedFileIds?: Set<string>
  onTabChange: (key: string) => void
  onTabClose: (key: string) => void
  onToggleLeftSidebar?: () => void
  onToggleRightSidebar?: () => void
  isLeftSidebarOpen?: boolean
  isRightSidebarOpen?: boolean
  onToggleSplit?: () => void
  isSplit?: boolean
  onOpenPlusModal?: () => void
  vaultName?: string
  vaults: VaultRecord[]
  currentVaultPath: string | null
  onSwitchVault: (path: string) => void
  onAddVault: () => void
  onRenameVault: (id: string, name: string) => void
  onDeleteVault: (id: string) => void
  onMoveVault: (id: string) => void
  onOpenVaultInExplorer: (path: string) => void
  onCloseAllTabs?: () => void
  leftTreeWidth?: number
  rightPanelWidth?: number
  activeFileId?: string
  favorites?: Set<string>
  onToggleFavorite?: (id: string) => void
}

const ACTIVITY_BAR_WIDTH = 40

function AmbyIcon({ className }: { className?: string }) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path
        d="M11.9771 17.966L12.9311 18.221C15.6311 18.941 16.9811 19.3 18.0451 18.689C19.1081 18.079 19.4701 16.736 20.1931 14.052L21.2161 10.255C21.9401 7.56998 22.3011 6.22799 21.6871 5.16999C21.0731 4.11199 19.7241 3.75298 17.0231 3.03398L16.0691 2.77898C13.3691 2.05898 12.0191 1.69998 10.9561 2.31098C9.89205 2.92099 9.53005 4.26398 8.80605 6.94798L7.78405 10.745C7.06005 13.43 6.69805 14.772 7.31305 15.83C7.92705 16.887 9.27705 17.247 11.9771 17.966Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M11.8926 5.52736C11.7158 5.973 11.7426 6.49309 12.0118 6.94337C12.1215 7.12678 12.2616 7.28238 12.4223 7.40747C12.2472 7.51108 12.0811 7.62934 11.9258 7.76129C11.9197 7.75446 11.9134 7.74761 11.9072 7.74073C11.8692 7.70332 11.6199 7.44725 11.5791 7.40927C11.5313 7.36941 11.2547 7.12923 11.2039 7.08975C11.1876 7.07707 10.7091 6.52863 10.6925 6.51602C10.6678 6.46836 10.6465 6.4209 10.6283 6.37402L10.5472 6.07105C10.5416 6.03506 10.5374 6.00007 10.5345 5.96633C10.5244 5.84822 10.3627 5.81296 10.3056 5.91663C9.83951 6.76359 9.89127 7.52626 10.3952 7.84294C10.763 8.07405 11.0327 8.34036 11.223 8.57454C11.1525 8.68738 11.088 8.80509 11.0301 8.92742C11.0261 8.92661 11.0222 8.92582 11.0182 8.92506C10.8863 8.89993 10.7733 8.88896 10.6163 8.89614C10.4183 8.9052 10.1842 8.97097 10.1197 8.99422C10.0552 9.01747 9.94828 9.06238 9.84687 9.12119C9.68129 9.21722 9.59427 9.28626 9.46541 9.42578C9.21508 9.69684 9.10602 9.96123 9.06008 10.274C9.03917 10.4164 9.2123 10.511 9.32517 10.4193C9.39818 10.36 9.47753 10.3061 9.56298 10.2585C9.86902 10.088 10.2087 10.0232 10.5378 10.0524C10.5118 10.1139 10.4855 10.1768 10.4587 10.2411C10.356 10.4885 10.2472 10.7586 10.1286 11.0652C9.88852 11.686 10.1304 12.3954 10.7115 12.7566C10.8239 12.8265 10.9373 12.8941 11.0516 12.9593C10.7056 13.154 10.4087 13.43 10.1929 13.7692C10.1856 13.7808 10.1783 13.7925 10.1711 13.8043C10.163 13.8175 10.155 13.8309 10.1471 13.8443C10.138 13.8599 10.1291 13.8756 10.1203 13.8914C10.1102 13.9095 10.1004 13.9279 10.0908 13.9463C10.0798 13.9675 10.0691 13.9888 10.0587 14.0104C10.046 14.0367 10.0337 14.0633 10.0219 14.0903C10.0069 14.1246 9.99265 14.1594 9.97918 14.1947C9.95013 14.2707 9.92473 14.349 9.90322 14.4293C9.86712 14.564 9.95046 14.7033 10.0894 14.7406L12.5254 15.3933L15.926 16.3045C16.0648 16.3417 16.2067 16.2627 16.2428 16.128C16.3245 15.823 16.3429 15.5155 16.3058 15.2189C16.3033 15.1991 16.3006 15.1794 16.2976 15.1597C16.2975 15.1592 16.2975 15.1587 16.2974 15.1583C16.2916 15.1198 16.2848 15.0815 16.2772 15.0434C16.2738 15.0266 16.2702 15.0098 16.2664 14.993C16.2629 14.9773 16.2593 14.9617 16.2554 14.9461C16.2518 14.9315 16.2481 14.9169 16.2443 14.9023C16.2406 14.8887 16.2369 14.8751 16.2331 14.8615C16.2294 14.8488 16.2257 14.8361 16.2219 14.8234C16.2183 14.8115 16.2147 14.7997 16.2109 14.7879C16.1545 14.6108 15.983 14.2803 15.983 14.2803C15.983 14.2803 16.2779 14.2777 16.3792 14.2753C17.0631 14.253 17.6272 13.7596 17.7297 13.1019C17.7866 12.7367 17.8311 12.4176 17.8685 12.1252C17.873 12.0898 17.8774 12.0548 17.8817 12.0202C18.1813 12.1595 18.4431 12.3854 18.6229 12.6861C18.6731 12.77 18.7148 12.8564 18.7484 12.9442C18.8003 13.0801 18.9975 13.0848 19.0506 12.951C19.1672 12.6571 19.205 12.3736 19.1237 12.0137C19.0819 11.8285 18.9779 11.6152 18.9456 11.5592C18.941 11.5511 18.9314 11.5349 18.9314 11.5349C18.8872 11.4825 18.6478 11.1434 18.3918 10.9796C18.2595 10.8949 18.1561 10.8479 18.0293 10.8037L18.026 10.8025L18.0235 10.8017C18.0216 10.8011 18.0198 10.8004 18.0179 10.7998C18.0288 10.6649 18.0318 10.5307 18.0273 10.3977C18.3092 10.2901 18.6758 10.1943 19.1099 10.178C19.7047 10.1558 20.1308 9.52114 20.1506 8.55459C20.1531 8.43629 19.9954 8.38598 19.9276 8.48319C19.9082 8.51096 19.7875 8.7111 19.6425 8.78933C19.2844 8.98247 18.8256 9.18972 18.5675 9.21962C18.3093 9.24951 17.8339 9.33918 17.8252 9.342C17.7567 9.15013 17.672 8.96463 17.5722 8.78737C17.7738 8.75935 17.973 8.69469 18.1597 8.59068C18.618 8.33535 18.9012 7.89835 18.9709 7.42398C18.9918 7.28153 18.8187 7.18701 18.7058 7.27868C18.6548 7.32011 18.6097 7.35327 18.5436 7.39478C18.3621 7.50881 18.2451 7.55716 18.0348 7.60738C17.7128 7.68425 17.5082 7.53282 17.1832 7.59717C16.9903 7.63538 16.8135 7.65998 16.7064 7.75463L16.7031 7.75757L16.7012 7.75034C16.2986 7.41941 15.8194 7.16729 15.2848 7.02405C14.7502 6.88081 14.2092 6.85956 13.6951 6.94486C13.6454 6.89749 13.5137 6.68913 13.3542 6.57118C13.1816 6.44359 13.032 6.46073 12.8525 6.3427C12.6702 6.22292 12.5749 6.13794 12.441 5.96783C12.3201 5.81411 12.2183 5.59545 12.1948 5.53406C12.1429 5.39824 11.9457 5.39353 11.8926 5.52736ZM11.7864 10.9558C11.7118 11.2342 11.884 11.5222 12.1711 11.5991C12.4581 11.6761 12.7513 11.5127 12.8259 11.2343L12.8952 10.9758C12.9697 10.6975 12.7975 10.4094 12.5105 10.3325C12.2234 10.2556 11.9302 10.4189 11.8556 10.6973L11.7864 10.9558ZM15.3092 11.8997C15.2346 12.1781 15.4068 12.4662 15.6939 12.5431C15.9809 12.62 16.2741 12.4567 16.3487 12.1783L16.418 11.9198C16.4925 11.6414 16.3203 11.3533 16.0333 11.2764C15.7462 11.1995 15.453 11.3629 15.3784 11.6412L15.3092 11.8997Z"
        fill="currentColor"
      />
      <path
        d="M12 20.946L11.048 21.206C8.35403 21.939 7.00803 22.306 5.94603 21.683C4.88603 21.061 4.52403 19.692 3.80303 16.955L2.78203 13.083C2.06003 10.346 1.69903 8.97697 2.31203 7.89897C2.84203 6.96597 4.00003 6.99997 5.50003 6.99997"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

function handleDragStart(e: React.MouseEvent) {
  if (e.button !== 0) return
  // Skip drag when the click originated on an interactive element.
  // Without this guard the mousedown bubbles from e.g. a sidebar-toggle button
  // up to the drag-region div, startDragging() captures the mouse pointer, and
  // the button's click event never fires.
  if ((e.target as HTMLElement).closest("button, a, input, select, [role='button']")) return
  if (isTauri()) {
    e.preventDefault()
    getCurrentWindow()
      .startDragging()
      .catch(() => {})
  }
}

export function HeaderTabs({
  tabs,
  activeTabKey,
  unsavedFileIds,
  onTabChange,
  onTabClose,
  onToggleLeftSidebar,
  onToggleRightSidebar,
  isLeftSidebarOpen = true,
  isRightSidebarOpen = true,
  onToggleSplit,
  isSplit = false,
  onOpenPlusModal,
  vaultName,
  vaults,
  currentVaultPath,
  onSwitchVault,
  onAddVault,
  onRenameVault,
  onDeleteVault,
  onMoveVault,
  onOpenVaultInExplorer,
  onCloseAllTabs,
  leftTreeWidth = 200,
  rightPanelWidth = 256,
  activeFileId,
  favorites,
  onToggleFavorite,
}: HeaderTabsProps) {
  const { t } = useTranslation()
  // activity bar in body = 44px (w-11);
  // mac traffic-light spacer = 72px;
  // non-mac logo on left = 44px. Picker width compensates so the editor area
  // in the header lines up with the body's main content area.
  const pickerWidth = isMac ? leftTreeWidth - 28 : leftTreeWidth
  const [isMaximized, setIsMaximized] = React.useState(false)
  const lastClickTimeRef = React.useRef(0)

  React.useEffect(() => {
    if (!isTauri()) return
    const win = getCurrentWindow()
    win
      .isMaximized()
      .then(setIsMaximized)
      .catch(() => {})
    let unlisten: (() => void) | undefined
    win
      .onResized(() => {
        win
          .isMaximized()
          .then(setIsMaximized)
          .catch(() => {})
      })
      .then((fn) => {
        unlisten = fn
      })
      .catch(() => {})
    return () => {
      unlisten?.()
    }
  }, [])

  function handleEmptySpaceMouseDown(e: React.MouseEvent) {
    if (e.button !== 0 || !isTauri()) return
    if ((e.target as HTMLElement).closest("button, a, input, select, [role='button']")) return
    e.preventDefault()
    const now = Date.now()
    const since = now - lastClickTimeRef.current
    lastClickTimeRef.current = now
    if (since < 300) {
      lastClickTimeRef.current = 0
      getCurrentWindow().toggleMaximize()
    } else {
      getCurrentWindow()
        .startDragging()
        .catch(() => {})
    }
  }

  const leftSidebarToggle = (
    <button
      onClick={onToggleLeftSidebar}
      onMouseDown={(e) => e.stopPropagation()}
      className="flex h-10 w-10 shrink-0 rounded items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-white"
    >
      {isLeftSidebarOpen ? (
        <PanelLeftClose className="size-4" />
      ) : (
        <PanelLeftOpen className="size-4 text-foreground" />
      )}
    </button>
  )

  const rightSidebarToggle = (
    <button
      onClick={onToggleRightSidebar}
      onMouseDown={(e) => e.stopPropagation()}
      className="flex h-10 w-10 shrink-0 rounded items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-white"
    >
      {isRightSidebarOpen ? (
        <PanelRightClose className="size-4" />
      ) : (
        <PanelRightOpen className="size-4 text-foreground" />
      )}
    </button>
  )

  const viewControls = (
    <div className="flex shrink-0 items-center">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex size-8 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-white">
            <ChevronDown className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56 border-border bg-popover text-foreground">
          <DropdownMenuItem
            disabled={!activeFileId}
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
            onSelect={() => activeFileId && onToggleFavorite?.(activeFileId)}
          >
            {activeFileId && favorites?.has(activeFileId) ? (
              <>
                <BookmarkCheck className="size-3.5 text-amber-400" />
                {t("tabs.removeBookmark")}
              </>
            ) : (
              <>
                <Bookmark className="size-3.5 text-muted-foreground" />
                {t("tabs.addBookmark")}
              </>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
            onSelect={onCloseAllTabs}
          >
            <X className="size-3.5 text-muted-foreground" />
            {t("tabs.closeAll")}
          </DropdownMenuItem>
          {tabs.length > 0 && (
            <>
              <DropdownMenuSeparator className="bg-accent" />
              {tabs.map((tab) => (
                <DropdownMenuItem
                  key={tab.key}
                  className={cn(
                    "flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white",
                    activeTabKey === tab.key && "text-white",
                  )}
                  onSelect={() => onTabChange(tab.key)}
                >
                  <span className="truncate">{tab.title}</span>
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {onToggleSplit && (
        <button
          onClick={onToggleSplit}
          title={t("tabs.splitEditor")}
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded transition-colors hover:bg-accent hover:text-white",
            isSplit ? "text-sky-400" : "text-muted-foreground",
          )}
        >
          <Columns2 className="size-4" />
        </button>
      )}
      {rightSidebarToggle}
    </div>
  )

  return (
    <header className="relative z-50 flex h-10 select-none items-stretch border-b border-border bg-background">
      {/* macOS traffic light spacer — native buttons live here */}
      {isMac ? (
        <div className="w-[80px] shrink-0" onMouseDown={handleDragStart} />
      ) : (
        /* Non-mac: logo on the left */
        <div
          className="flex w-11 shrink-0 items-center justify-center"
          onMouseDown={handleDragStart}
        >
          <AmbyIcon className="pointer-events-none size-5 text-foreground" />
        </div>
      )}

      {/* Left activity bar header column (always present, mirrors body) */}
      <div style={{ width: 0 }} className="shrink-0" onMouseDown={handleDragStart} />

      {/* Workspace switcher (left panel header column, only when panel open) */}
      {isLeftSidebarOpen && (
        <div
          className="flex shrink-0 items-center"
          style={{ width: pickerWidth + ACTIVITY_BAR_WIDTH }}
          onMouseDown={handleDragStart}
        >
          <div className="flex min-w-0 flex-1 items-center px-3">
            <WorkspacePicker
              vaults={vaults}
              currentPath={currentVaultPath}
              onSelect={onSwitchVault}
              onAdd={onAddVault}
              onRename={onRenameVault}
              onDelete={onDeleteVault}
              onMove={onMoveVault}
              onOpenInExplorer={onOpenVaultInExplorer}
            >
              <button
                className="flex min-w-0 items-center gap-1.5 rounded px-2 py-1 text-sm transition-colors hover:bg-accent"
                onMouseDown={(e) => e.stopPropagation()}
              >
                <span className="truncate font-medium text-foreground">
                  {vaultName ?? "Workspace"}
                </span>
                <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
              </button>
            </WorkspacePicker>
          </div>
          <div className="flex shrink-0">{leftSidebarToggle}</div>
        </div>
      )}

      {/* Editor area header (flex-1) */}
      <div className="flex flex-1 items-center justify-between overflow-hidden">
        <div className="flex h-full items-center overflow-hidden">
          {!isLeftSidebarOpen && leftSidebarToggle}

          <div className="flex h-full items-center overflow-hidden">
            {tabs.map((tab) => (
              <div
                key={tab.key}
                onClick={() => onTabChange(tab.key)}
                onMouseDown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault()
                    onTabClose(tab.key)
                  }
                }}
                className={cn(
                  "group relative flex h-full shrink-0 cursor-pointer items-center gap-2 px-3 text-sm transition-colors",
                  activeTabKey === tab.key
                    ? "bg-card text-white"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                {unsavedFileIds?.has(tab.fileId) && (
                  <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground" />
                )}
                <span className="max-w-32 truncate">{tab.title}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onTabClose(tab.key)
                  }}
                  className="flex size-4 items-center justify-center rounded text-muted-foreground opacity-0 transition-all group-hover:opacity-100 hover:bg-accent hover:text-white"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>

          <button
            onClick={onOpenPlusModal}
            className="flex shrink-0 size-8 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-white"
          >
            <Plus className="size-4" />
          </button>
        </div>

        <div className="flex-1 h-full cursor-default" onMouseDown={handleEmptySpaceMouseDown} />
      </div>

      {/* Right-side drag region mirroring the body (panel + activity bar when
          open). Window controls are absolutely positioned below, so this fills
          the true layout width and the editor's view controls land exactly on
          the panel divider — same as the left toggle on its panel. When closed
          it just clears the (absolute) window controls. */}
      {/* View controls — absolutely positioned so their right edge lands on the
          panel divider (right offset = panel width + activity bar). Mirrors the
          left toggle sitting on the left panel's inner edge, and is robust to
          panel resizing. When closed they sit just left of the window controls. */}
      <div
        className="absolute top-0 z-10 flex h-10 items-center border-b border-border bg-background"
        style={{ right: isRightSidebarOpen ? rightPanelWidth + ACTIVITY_BAR_WIDTH + 2 : 146 }}
      >
        {viewControls}
      </div>

      {/* macOS: logo on the right */}
      {isMac && (
        <div
          className="flex w-11 shrink-0 items-center justify-center"
          onMouseDown={handleDragStart}
        >
          <AmbyIcon className="pointer-events-none size-5 text-foreground" />
        </div>
      )}

      {/* Non-mac window controls — absolutely positioned so they don't consume
          flex width (the body has no window controls on this side, so the
          editor's view controls line up with the panel divider). */}
      {!isMac && (
        <div className="absolute right-0 top-0 flex h-10 items-center border-b border-border bg-background">
          <button
            onClick={() => isTauri() && getCurrentWindow().minimize()}
            className="flex h-10 w-12 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-white"
          >
            <Minus className="size-4" />
          </button>
          <button
            onClick={() => isTauri() && getCurrentWindow().toggleMaximize()}
            className="flex h-10 w-12 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-white"
          >
            {isMaximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </button>
          <button
            onClick={() => isTauri() && getCurrentWindow().close()}
            className="flex h-10 w-12 items-center justify-center text-muted-foreground transition-colors hover:bg-red-600 hover:text-white"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
    </header>
  )
}
