import type * as React from "react"

type WorkspaceLayoutProps = {
  deleteConfirmationDialog: React.ReactNode
  dialogs: React.ReactNode
  focusContent: React.ReactNode
  focusLeftOverlay: React.ReactNode
  focusRightOverlay: React.ReactNode
  header: React.ReactNode
  isFocusMode: boolean
  leftActivityBar: React.ReactNode
  leftSidebar: React.ReactNode
  noVault: React.ReactNode | null
  normalContent: React.ReactNode
  notice: React.ReactNode
  onFocusPointerMove: (event: React.MouseEvent<HTMLDivElement>) => void
  rightActivityBar: React.ReactNode
  rightSidebar: React.ReactNode
}

/** Pure workspace chrome. Domain state stays in the orchestration hook tree. */
export function WorkspaceLayout({
  deleteConfirmationDialog,
  dialogs,
  focusContent,
  focusLeftOverlay,
  focusRightOverlay,
  header,
  isFocusMode,
  leftActivityBar,
  leftSidebar,
  noVault,
  normalContent,
  notice,
  onFocusPointerMove,
  rightActivityBar,
  rightSidebar,
}: WorkspaceLayoutProps) {
  if (noVault) return noVault

  if (isFocusMode) {
    return (
      <div
        className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-background"
        onMouseMove={onFocusPointerMove}
      >
        {focusContent}
        {focusLeftOverlay}
        {focusRightOverlay}
        {dialogs}
        {notice}
        {deleteConfirmationDialog}
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[var(--workspace-bg)]">
      {header}
      {deleteConfirmationDialog}
      <div className="flex flex-1 overflow-hidden bg-[var(--workspace-bg)]">
        {leftActivityBar}
        {leftSidebar}
        <main className="flex flex-1 gap-0 overflow-hidden bg-[var(--workspace-bg)]">
          {normalContent}
        </main>
        {rightSidebar}
        {rightActivityBar}
      </div>
      {dialogs}
      {notice}
    </div>
  )
}
