"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { FileText } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import type { TreeItem } from "../tree/tree-types"
import { quickOpenRelativePath, rankQuickOpenFiles } from "../quick-open-utils"

export interface CanvasNotePickerModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  treeItems: TreeItem[]
  vault?: string | null
  onSelectNote: (notePath: string) => void
}

function collectNotes(items: TreeItem[]): TreeItem[] {
  const result: TreeItem[] = []
  for (const item of items) {
    if (item.type === "file") {
      const isCanvas = item.path.endsWith(".canvas")
      const isSketch = item.path.endsWith(".excalidraw")
      if (!isCanvas && !isSketch) {
        result.push(item)
      }
    }
    if (item.children && item.children.length > 0) {
      result.push(...collectNotes(item.children))
    }
  }
  return result
}

export function CanvasNotePickerModal({
  open,
  onOpenChange,
  treeItems,
  vault,
  onSelectNote,
}: CanvasNotePickerModalProps) {
  const { t } = useTranslation()
  const [query, setQuery] = React.useState("")

  const notes = React.useMemo(() => collectNotes(treeItems), [treeItems])

  React.useEffect(() => {
    if (open) setQuery("")
  }, [open])

  const filteredNotes = React.useMemo(() => {
    return rankQuickOpenFiles(notes, query, vault, 50)
  }, [notes, query, vault])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 p-0 overflow-hidden border-border bg-popover text-foreground">
        <DialogHeader className="sr-only">
          <DialogTitle>{t("canvas.notePickerTitle")}</DialogTitle>
        </DialogHeader>

        <Command className="rounded-none border-none bg-transparent" shouldFilter={false}>
          <CommandInput
            placeholder={t("canvas.notePickerPlaceholder")}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="max-h-72">
            {filteredNotes.length === 0 ? (
              <CommandEmpty>{t("canvas.noNotesFound")}</CommandEmpty>
            ) : (
              <CommandGroup>
                {filteredNotes.map((note) => {
                  const displayName = note.name.replace(/\.md$/u, "")
                  const relPath = quickOpenRelativePath(note, vault)
                  return (
                    <CommandItem
                      key={note.id}
                      value={note.id}
                      onSelect={() => {
                        onSelectNote(relPath)
                        onOpenChange(false)
                      }}
                      className="flex items-center gap-2.5 px-3 py-2 cursor-pointer"
                    >
                      <FileText className="size-4 shrink-0 text-muted-foreground" />
                      <div className="flex flex-col min-w-0 flex-1">
                        <span className="text-xs font-medium truncate text-foreground">
                          {displayName}
                        </span>
                        {relPath !== displayName && (
                          <span className="text-[10px] text-muted-foreground truncate">
                            {relPath}
                          </span>
                        )}
                      </div>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
