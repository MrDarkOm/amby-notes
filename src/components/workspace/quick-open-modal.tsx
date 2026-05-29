"use client"

import * as React from "react"
import { FileText, Plus } from "lucide-react"
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import { useTranslation } from "react-i18next"
import type { TreeItem } from "./sidebar-tree"

interface QuickOpenModalProps {
  open: boolean
  onClose: () => void
  treeItems: TreeItem[]
  onSelectFile: (id: string) => void
  onNewNote: () => void
}

function flattenFiles(items: TreeItem[]): TreeItem[] {
  const result: TreeItem[] = []
  for (const item of items) {
    if (item.type === "file") result.push(item)
    if (item.children) result.push(...flattenFiles(item.children))
  }
  return result
}

export function QuickOpenModal({ open, onClose, treeItems, onSelectFile, onNewNote }: QuickOpenModalProps) {
  const { t } = useTranslation()
  const files = React.useMemo(() => flattenFiles(treeItems), [treeItems])

  function handleSelect(id: string) {
    onSelectFile(id)
    onClose()
  }

  function handleNewNote() {
    onClose()
    onNewNote()
  }

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="w-[480px] border-zinc-800 bg-zinc-950 p-0 shadow-2xl [&>button]:hidden">
        <Command className="rounded-lg bg-transparent">
          <CommandInput
            placeholder={t("quickOpen.searchPlaceholder")}
            className="h-11 border-none text-zinc-200 placeholder:text-zinc-500 focus:ring-0"
          />
          <CommandList className="max-h-72 overflow-y-auto">
            <CommandEmpty className="py-6 text-center text-sm text-zinc-500">
              {t("quickOpen.noFiles")}
            </CommandEmpty>

            <CommandGroup heading={t("quickOpen.actionsHeading")} className="[&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-zinc-600 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
              <CommandItem
                onSelect={handleNewNote}
                className="flex items-center gap-2.5 rounded-md px-2 py-2 text-[13px] text-zinc-300 aria-selected:bg-zinc-800 aria-selected:text-white cursor-pointer"
              >
                <div className="flex size-6 items-center justify-center rounded bg-zinc-800">
                  <Plus className="size-3.5 text-zinc-400" />
                </div>
                {t("quickOpen.createNote")}
              </CommandItem>
            </CommandGroup>

            {files.length > 0 && (
              <>
                <CommandSeparator className="bg-zinc-800" />
                <CommandGroup heading={t("quickOpen.filesHeading")} className="[&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-zinc-600 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
                  {files.map(file => (
                    <CommandItem
                      key={file.id}
                      value={file.name}
                      onSelect={() => handleSelect(file.id)}
                      className="flex items-center gap-2.5 rounded-md px-2 py-2 text-[13px] text-zinc-300 aria-selected:bg-zinc-800 aria-selected:text-white cursor-pointer"
                    >
                      <FileText className="size-4 shrink-0 text-zinc-500" />
                      <span className="truncate">{file.name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
