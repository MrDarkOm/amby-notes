import * as React from "react"
import { Lock, LockOpen, Redo2, Settings2, Undo2 } from "lucide-react"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ToolbarButton } from "../common/toolbar-button"

export interface PageBarLock {
  locked: boolean
  onToggle: () => void
  /** What the button says it will do. */
  title: string
  disabled?: boolean
  /** Reports the state to assistive tools as a toggle (a switch rather than a mode). */
  asToggle?: boolean
}

export interface PageBarSettings {
  title: string
  /** A popover of settings; without it the button calls `onClick`. */
  content?: React.ReactNode
  onClick?: () => void
  active?: boolean
  /** Reports `active` to assistive tools as a toggle's state. */
  toggle?: boolean
}

export interface PageFloatingBarProps {
  /** Nothing is drawn (the author hid the bar). */
  hidden?: boolean
  /** When the page was last changed, already worded. Dropped on a narrow bar. */
  modified?: string
  /** The words of the page. */
  wordCount?: React.ReactNode
  /** Any text in place of the time and words (the graph's counts). */
  summary?: React.ReactNode
  /** Undo and Redo; both are left out while `historyDisabled` (a locked page). */
  onUndo?: () => void
  onRedo?: () => void
  undoLabel?: string
  redoLabel?: string
  historyDisabled?: boolean
  lock?: PageBarLock
  settings?: PageBarSettings
}

const SEPARATOR = <div className="mx-0.5 h-3.5 w-px bg-border/80" />

/**
 * The floating bar at the foot of a page: when it changed, its words, undo and redo, the lock and
 * the settings. Every part is optional and appears only when the surface passes it in.
 */
export function PageFloatingBar({
  hidden = false,
  modified,
  wordCount,
  summary,
  onUndo,
  onRedo,
  undoLabel,
  redoLabel,
  historyDisabled = false,
  lock,
  settings,
}: PageFloatingBarProps) {
  if (hidden) return null

  const stats =
    summary !== undefined || wordCount !== undefined || modified ? (
      <div
        key="stats"
        className="flex items-center px-1.5 text-[11px] text-muted-foreground select-none"
      >
        {summary !== undefined ? (
          summary
        ) : (
          <>
            {modified ? (
              <>
                <span className="hidden sm:inline">{modified}</span>
                {wordCount !== undefined ? (
                  <span className="hidden sm:inline mx-1.5 text-border/80">·</span>
                ) : null}
              </>
            ) : null}
            {wordCount !== undefined ? <span>{wordCount}</span> : null}
          </>
        )}
      </div>
    ) : null

  const history =
    !historyDisabled && (onUndo || onRedo) ? (
      <React.Fragment key="history">
        <ToolbarButton
          title={undoLabel ?? ""}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onUndo}
        >
          <Undo2 className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton
          title={redoLabel ?? ""}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onRedo}
        >
          <Redo2 className="size-3.5" />
        </ToolbarButton>
      </React.Fragment>
    ) : null

  const lockButton = lock ? (
    <ToolbarButton
      title={lock.title}
      active={lock.locked}
      disabled={lock.disabled}
      aria-pressed={lock.asToggle ? lock.locked : undefined}
      onMouseDown={lock.asToggle ? undefined : (e) => e.preventDefault()}
      onClick={lock.onToggle}
    >
      {lock.locked ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
    </ToolbarButton>
  ) : null

  const settingsButton = settings ? (
    settings.content ? (
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            title={settings.title}
            onMouseDown={(e) => e.preventDefault()}
            className="flex size-7 items-center justify-center rounded-lg text-foreground hover:bg-accent hover:text-accent-foreground select-none"
          >
            <Settings2 className="size-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={13}
          alignOffset={-5}
          className="w-64 rounded-xl border border-border/80 bg-popover/95 p-3 text-foreground shadow-lg backdrop-blur-md"
        >
          {settings.content}
        </PopoverContent>
      </Popover>
    ) : (
      <ToolbarButton
        title={settings.title}
        active={settings.active}
        aria-pressed={settings.toggle ? settings.active : undefined}
        onClick={settings.onClick}
      >
        <Settings2 className="size-3.5" />
      </ToolbarButton>
    )
  ) : null

  const sections = [
    stats,
    history,
    lockButton || settingsButton ? (
      <React.Fragment key="tools">
        {lockButton}
        {settingsButton}
      </React.Fragment>
    ) : null,
  ].filter(Boolean)
  if (sections.length === 0) return null

  return (
    <div className="pointer-events-none absolute bottom-2 right-4 z-10 select-none max-w-[calc(100%-2rem)]">
      <div className="pointer-events-auto flex items-center gap-0.5 rounded-xl border border-border/80 bg-card/90 p-1 shadow-md backdrop-blur-md">
        {sections.map((section, index) => (
          <React.Fragment key={index}>
            {index > 0 ? SEPARATOR : null}
            {section}
          </React.Fragment>
        ))}
      </div>
    </div>
  )
}
