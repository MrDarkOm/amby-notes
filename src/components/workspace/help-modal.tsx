"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

export type HelpContext = "note" | "canvas" | "sketch" | "database" | "workspace"

export interface HelpModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialContext?: HelpContext
}

interface ShortcutItem {
  key: string
  label: string
}

export function HelpModal({ open, onOpenChange, initialContext = "workspace" }: HelpModalProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = React.useState<HelpContext>(initialContext)

  React.useEffect(() => {
    if (open) {
      setActiveTab(initialContext)
    }
  }, [open, initialContext])

  const tabs: { id: HelpContext; label: string }[] = React.useMemo(
    () => [
      { id: "note", label: t("help.tabs.note") },
      { id: "canvas", label: t("help.tabs.canvas") },
      { id: "sketch", label: t("help.tabs.sketch") },
      { id: "database", label: t("help.tabs.database") },
      { id: "workspace", label: t("help.tabs.general") },
    ],
    [t],
  )

  const items: ShortcutItem[] = React.useMemo(() => {
    switch (activeTab) {
      case "note":
        return [
          { key: "⌘B / Ctrl+B", label: t("help.note.bold") },
          { key: "⌘I / Ctrl+I", label: t("help.note.italic") },
          { key: "⌘U / Ctrl+U", label: t("help.note.underline") },
          { key: "⇧⌘X / Ctrl+Shift+X", label: t("help.note.strikethrough") },
          { key: "⌘E / Ctrl+E", label: t("help.note.code") },
          { key: "⌘K / [[", label: t("help.note.link") },
          { key: "# .. ######", label: t("help.note.headings") },
          { key: "- / * + Space", label: t("help.note.bulletList") },
          { key: "1. + Space", label: t("help.note.numberedList") },
          { key: "[ ] + Space", label: t("help.note.taskList") },
          { key: "> + Space", label: t("help.note.quote") },
          { key: "``` + Space", label: t("help.note.codeBlock") },
          { key: "---", label: t("help.note.divider") },
          { key: "⌘Z / ⇧⌘Z", label: t("help.note.undoRedo") },
        ]
      case "canvas":
        return [
          { key: "V", label: t("canvas.hotkeySelect") },
          { key: "H", label: t("canvas.hotkeyHand") },
          { key: "Space", label: t("canvas.hotkeySpace") },
          { key: "⌘Z / Ctrl+Z", label: t("canvas.hotkeyUndo") },
          { key: "⇧⌘Z / Ctrl+Y", label: t("canvas.hotkeyRedo") },
          { key: "⌘D / Ctrl+D", label: t("canvas.hotkeyDuplicate") },
          { key: "⌘C / ⌘V", label: t("canvas.hotkeyCopyPaste") },
          { key: "Delete / ⌫", label: t("canvas.hotkeyDelete") },
          { key: "Double click", label: t("canvas.hotkeyEditLabel") },
          { key: "Double click", label: t("canvas.hotkeyOpenNote") },
        ]
      case "sketch":
        return [
          { key: "V / 1", label: t("help.sketch.select") },
          { key: "H", label: t("help.sketch.hand") },
          { key: "Space", label: t("help.sketch.space") },
          { key: "R / 2", label: t("help.sketch.rectangle") },
          { key: "D / 3", label: t("help.sketch.diamond") },
          { key: "E / 4", label: t("help.sketch.ellipse") },
          { key: "A / 5", label: t("help.sketch.arrow") },
          { key: "L / 6", label: t("help.sketch.line") },
          { key: "P / 7", label: t("help.sketch.pen") },
          { key: "T / 8", label: t("help.sketch.text") },
          { key: "0 / 9", label: t("help.sketch.eraser") },
          { key: "⌘Z / ⇧⌘Z", label: t("help.sketch.undoRedo") },
          { key: "⌘D / Ctrl+D", label: t("help.sketch.duplicate") },
          { key: "Delete / ⌫", label: t("help.sketch.delete") },
        ]
      case "database":
        return [
          { key: "Space / Enter", label: t("help.database.openRow") },
          { key: "Enter", label: t("help.database.editCell") },
          { key: "Tab / ⇧Tab", label: t("help.database.navigate") },
          { key: "Esc", label: t("help.database.cancel") },
          { key: "⌘F / Ctrl+F", label: t("help.database.search") },
        ]
      case "workspace":
      default:
        return [
          { key: "⌘P / Ctrl+P", label: t("help.general.quickOpen") },
          { key: "⇧⌘F / Ctrl+Shift+F", label: t("help.general.search") },
          { key: "⌘N / Ctrl+N", label: t("help.general.newNote") },
          { key: "⌘B / Ctrl+B", label: t("help.general.toggleLeftSidebar") },
          { key: "⇧⌘B / Ctrl+Shift+B", label: t("help.general.toggleRightSidebar") },
          { key: "⌘, / Ctrl+,", label: t("help.general.settings") },
          { key: "⌘[ / Ctrl+[", label: t("help.general.back") },
          { key: "⌘] / Ctrl+]", label: t("help.general.forward") },
        ]
    }
  }, [activeTab, t])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg border-border bg-popover text-foreground">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">{t("help.title")}</DialogTitle>
          <p className="text-xs text-muted-foreground">{t("help.desc")}</p>
        </DialogHeader>

        {/* Category Tabs */}
        <div className="mt-1 flex items-center gap-1 rounded-xl border border-border/80 bg-muted/40 p-1">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "flex-1 rounded-lg px-2 py-1.5 text-xs font-medium",
                  isActive
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                )}
              >
                {tab.label}
              </button>
            )
          })}
        </div>

        {/* Shortcuts List */}
        <div className="mt-2 max-h-[50vh] divide-y divide-border/60 overflow-y-auto rounded-xl border border-border/80 bg-card/60">
          {items.map((it, idx) => (
            <div key={idx} className="flex items-center justify-between px-3.5 py-2 text-xs">
              <span className="text-foreground/90">{it.label}</span>
              <kbd className="rounded border border-border bg-muted/80 px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                {it.key}
              </kbd>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
