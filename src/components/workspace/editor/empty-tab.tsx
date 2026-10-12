import * as React from "react"
import {
  BookOpen,
  Database,
  Feather,
  FolderOpen,
  Globe2,
  LayoutGrid,
  PenLine,
  Search,
  SquarePen,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { formatShortcut } from "../keyboard-shortcuts"
import { useSettingsStore } from "../use-settings-store"

interface EmptyTabProps {
  /** No vault is open: the only thing to offer is opening one. */
  hasVault: boolean
  onNewNote?: () => void
  onNewDatabase?: () => void
  onNewCanvas?: () => void
  onNewSketch?: () => void
  onQuickOpen?: () => void
  onOpenVault?: () => void
  /** Offered, under their own heading, only while the creative module is on. */
  creative?: {
    onNewStory: () => void
    onNewUniverse: () => void
    onOpenWorkshop: () => void
  }
}

interface Action {
  id: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  shortcut?: string
  run: () => void
}

/** A shortcut as keycaps: "⌘ N" on a Mac, "Ctrl + N" elsewhere. */
function keycaps(binding: string): string {
  const mac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)
  const text = formatShortcut(binding, mac)
  return mac ? text.split(" + ").join(" ") : text
}

/**
 * What a tab with no file shows: the few things one does next, each with its shortcut. Only the
 * actions whose module is on and whose handler exists are offered.
 */
export function EmptyTab({
  hasVault,
  onNewNote,
  onNewDatabase,
  onNewCanvas,
  onNewSketch,
  onQuickOpen,
  onOpenVault,
  creative,
}: EmptyTabProps) {
  const { t } = useTranslation()
  const shortcuts = useSettingsStore((state) => state.prefs.shortcuts)

  const actions: Action[] = []
  if (!hasVault) {
    if (onOpenVault) {
      actions.push({
        id: "vault",
        label: t("docEditor.openVault"),
        icon: FolderOpen,
        run: onOpenVault,
      })
    }
  } else {
    if (onNewNote) {
      actions.push({
        id: "note",
        label: t("docEditor.empty.newNote"),
        icon: SquarePen,
        shortcut: shortcuts.newNote,
        run: onNewNote,
      })
    }
    if (onNewDatabase) {
      actions.push({
        id: "database",
        label: t("docEditor.empty.newDatabase"),
        icon: Database,
        run: onNewDatabase,
      })
    }
    if (onNewCanvas) {
      actions.push({
        id: "canvas",
        label: t("docEditor.empty.newCanvas"),
        icon: LayoutGrid,
        run: onNewCanvas,
      })
    }
    if (onNewSketch) {
      actions.push({
        id: "sketch",
        label: t("docEditor.empty.newSketch"),
        icon: PenLine,
        run: onNewSketch,
      })
    }
    if (onQuickOpen) {
      actions.push({
        id: "open",
        label: t("docEditor.empty.goToFile"),
        icon: Search,
        shortcut: shortcuts.quickOpen,
        run: onQuickOpen,
      })
    }
  }

  const creativeActions: Action[] =
    hasVault && creative
      ? [
          {
            id: "story",
            label: t("docEditor.empty.newStory"),
            icon: BookOpen,
            run: creative.onNewStory,
          },
          {
            id: "universe",
            label: t("docEditor.empty.newUniverse"),
            icon: Globe2,
            run: creative.onNewUniverse,
          },
          {
            id: "workshop",
            label: t("docEditor.empty.openWorkshop"),
            icon: Feather,
            run: creative.onOpenWorkshop,
          },
        ]
      : []

  const renderAction = ({ id, label, icon: Icon, shortcut, run }: Action) => (
    <button
      key={id}
      type="button"
      onClick={run}
      className="flex w-full items-center gap-3 rounded-full border border-border/70 bg-card px-4 py-3 text-left text-sm text-foreground hover:border-primary/40 hover:bg-accent/40"
    >
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcut && (
        <kbd className="shrink-0 rounded-full bg-accent px-2.5 py-0.5 font-sans text-xs text-muted-foreground">
          {keycaps(shortcut)}
        </kbd>
      )}
    </button>
  )

  return (
    <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-6">
      <div className="flex w-full max-w-xs flex-col gap-2.5">{actions.map(renderAction)}</div>
      {creativeActions.length > 0 && (
        <div className="mt-7 flex w-full max-w-xs flex-col gap-2.5">
          <p className="px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("docEditor.empty.creative")}
          </p>
          {creativeActions.map(renderAction)}
        </div>
      )}
    </div>
  )
}
