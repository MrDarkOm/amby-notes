"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { Check, FolderOpen, FolderTree, MoreHorizontal, PenLine, Plus, Unlink } from "lucide-react"
import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export interface VaultRecord {
  id: string
  name: string
  path: string
}

interface WorkspacePickerProps {
  children: React.ReactNode
  vaults: VaultRecord[]
  currentPath: string | null
  onSelect: (path: string) => void
  onAdd: () => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  onMove: (id: string) => void
  onOpenInExplorer: (path: string) => void
}

export function WorkspacePicker({
  children,
  vaults,
  currentPath,
  onSelect,
  onAdd,
  onRename,
  onDelete,
  onMove,
  onOpenInExplorer,
}: WorkspacePickerProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const [renamingId, setRenamingId] = React.useState<string | null>(null)
  const [renameValue, setRenameValue] = React.useState("")
  const renameInputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (renamingId) setTimeout(() => renameInputRef.current?.focus(), 0)
  }, [renamingId])

  function commitRename(id: string) {
    const trimmed = renameValue.trim()
    if (trimmed) onRename(id, trimmed)
    setRenamingId(null)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-64 border-zinc-800 bg-black p-0 shadow-xl"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="border-b border-zinc-800 px-3 py-2">
          <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">{t("vaultPicker.vaults")}</p>
        </div>

        <div className="flex max-h-64 flex-col overflow-y-auto p-1">
          {vaults.length === 0 && (
            <p className="px-3 py-2 text-[12px] text-zinc-600">{t("vaultPicker.noVaults")}</p>
          )}
          {vaults.map(vault => (
            <div
              key={vault.id}
              className={cn(
                "group flex items-center gap-2 rounded px-2 py-1.5 hover:bg-zinc-800",
                vault.path === currentPath && "bg-zinc-800/60"
              )}
            >
              {/* Check mark for active */}
              <div className="flex size-4 shrink-0 items-center justify-center">
                {vault.path === currentPath && <Check className="size-3 text-zinc-300" />}
              </div>

              {/* Name / rename input */}
              {renamingId === vault.id ? (
                <input
                  ref={renameInputRef}
                  value={renameValue}
                  onChange={e => setRenameValue(e.target.value)}
                  onBlur={() => commitRename(vault.id)}
                  onKeyDown={e => {
                    if (e.key === "Enter") commitRename(vault.id)
                    if (e.key === "Escape") setRenamingId(null)
                    e.stopPropagation()
                  }}
                  onClick={e => e.stopPropagation()}
                  className="flex-1 min-w-0 rounded bg-zinc-700 px-1.5 py-0.5 text-[13px] text-zinc-100 outline-none ring-1 ring-blue-500"
                />
              ) : (
                <button
                  className="flex-1 min-w-0 text-left"
                  onClick={() => { onSelect(vault.path); setOpen(false) }}
                >
                  <span className="block truncate text-[13px] text-zinc-200">{vault.name}</span>
                  <span className="block truncate text-[10px] text-zinc-600">{vault.path}</span>
                </button>
              )}

              {/* Three-dot menu */}
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <button
                    onClick={e => e.stopPropagation()}
                    className="flex size-5 shrink-0 items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 hover:bg-zinc-700"
                  >
                    <MoreHorizontal className="size-3.5 text-zinc-400" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  className="w-48 border-zinc-800 bg-black text-zinc-300"
                  align="end"
                  onClick={e => e.stopPropagation()}
                  onCloseAutoFocus={e => e.preventDefault()}
                >
                  <DropdownMenuItem
                    className="flex items-center gap-2 text-[13px] focus:bg-zinc-800 focus:text-white"
                    onSelect={() => { setRenameValue(vault.name); setRenamingId(vault.id) }}
                  >
                    <PenLine className="size-3.5 text-zinc-500" />
                    {t("vaultPicker.rename")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="flex items-center gap-2 text-[13px] focus:bg-zinc-800 focus:text-white"
                    onSelect={() => onMove(vault.id)}
                  >
                    <FolderTree className="size-3.5 text-zinc-500" />
                    {t("vaultPicker.move")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="flex items-center gap-2 text-[13px] focus:bg-zinc-800 focus:text-white"
                    onSelect={() => onOpenInExplorer(vault.path)}
                  >
                    <FolderOpen className="size-3.5 text-zinc-500" />
                    {t("vaultPicker.showInExplorer")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator className="bg-zinc-800" />
                  <DropdownMenuItem
                    className="flex items-center gap-2 text-[13px] text-red-400 focus:bg-zinc-800 focus:text-red-300"
                    onSelect={() => onDelete(vault.id)}
                  >
                    <Unlink className="size-3.5" />
                    {t("vaultPicker.detach")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
        </div>

        <div className="border-t border-zinc-800 p-1">
          <button
            onClick={() => { onAdd(); setOpen(false) }}
            className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-[13px] text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          >
            <Plus className="size-3.5" />
            {t("vaultPicker.openOrCreate")}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
