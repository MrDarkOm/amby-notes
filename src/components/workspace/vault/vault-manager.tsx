"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { Check, FolderOpen, FolderTree, MoreHorizontal, PenLine, Unlink } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SUPPORTED_LANGUAGES } from "@/lib/i18n"
import { cn } from "@/lib/utils"
import type { Language } from "../app-config"
import { useSettingsStore } from "../use-settings-store"
import type { VaultRecord } from "../workspace-picker"

export interface VaultManagerProps {
  vaults: VaultRecord[]
  /** The open vault, if any; the start screen has none. */
  currentPath?: string | null
  onSelect: (path: string) => void
  onOpenVault: () => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  onMove: (id: string) => void
  onOpenInExplorer: (path: string) => void
}

const MENU_ITEM = "flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"

/** Known vaults with their actions, the vault chooser and the language switch. */
export function VaultManager({
  vaults,
  currentPath = null,
  onSelect,
  onOpenVault,
  onRename,
  onDelete,
  onMove,
  onOpenInExplorer,
}: VaultManagerProps) {
  const { t } = useTranslation()
  const language = useSettingsStore((s) => s.prefs.language)
  const setPrefs = useSettingsStore((s) => s.setPrefs)
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
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {t("startScreen.recent")}
        </p>
        {vaults.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-3 text-[12px] text-muted-foreground">
            {t("startScreen.noRecent")}
          </p>
        ) : (
          <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
            {vaults.map((vault) => {
              const isCurrent = vault.path === currentPath
              return (
                <li
                  key={vault.id}
                  className={cn(
                    "group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent",
                    isCurrent && "bg-accent/60",
                  )}
                >
                  <div className="flex size-4 shrink-0 items-center justify-center">
                    {isCurrent && <Check className="size-3 text-foreground" />}
                  </div>
                  {renamingId === vault.id ? (
                    <input
                      ref={renameInputRef}
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => commitRename(vault.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(vault.id)
                        if (e.key === "Escape") setRenamingId(null)
                        e.stopPropagation()
                      }}
                      className="min-w-0 flex-1 rounded bg-accent px-1.5 py-0.5 text-[13px] text-foreground outline-none ring-1 ring-ring"
                    />
                  ) : (
                    <button
                      type="button"
                      title={vault.path}
                      onClick={() => onSelect(vault.path)}
                      className="min-w-0 flex-1 rounded-md text-left outline-none focus-visible:bg-accent/70"
                    >
                      <span className="block truncate text-[13px] text-foreground">
                        {vault.name}
                      </span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {vault.path}
                      </span>
                    </button>
                  )}
                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        title={t("vaultPicker.actions")}
                        aria-label={t("vaultPicker.actions")}
                        className="flex size-6 shrink-0 items-center justify-center rounded outline-none hover:bg-background/60 focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        <MoreHorizontal className="size-3.5 text-muted-foreground" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      className="w-48 border-border bg-popover text-foreground"
                      align="end"
                      onCloseAutoFocus={(e) => e.preventDefault()}
                    >
                      <DropdownMenuItem
                        className={MENU_ITEM}
                        onSelect={() => {
                          setRenameValue(vault.name)
                          setRenamingId(vault.id)
                        }}
                      >
                        <PenLine className="size-3.5 text-muted-foreground" />
                        {t("vaultPicker.rename")}
                      </DropdownMenuItem>
                      <DropdownMenuItem className={MENU_ITEM} onSelect={() => onMove(vault.id)}>
                        <FolderTree className="size-3.5 text-muted-foreground" />
                        {t("vaultPicker.move")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className={MENU_ITEM}
                        onSelect={() => onOpenInExplorer(vault.path)}
                      >
                        <FolderOpen className="size-3.5 text-muted-foreground" />
                        {t("vaultPicker.showInExplorer")}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator className="bg-accent" />
                      <DropdownMenuItem
                        className="flex items-center gap-2 text-[13px] text-red-400 focus:bg-accent focus:text-red-300"
                        onSelect={() => onDelete(vault.id)}
                      >
                        <Unlink className="size-3.5" />
                        {t("vaultPicker.detach")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <button
        type="button"
        onClick={onOpenVault}
        className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm text-foreground outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring"
      >
        <FolderOpen className="size-4" />
        {t("vaultPicker.choose")}
      </button>

      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] text-muted-foreground">
          {t("settings.appearance.language")}
        </span>
        <Select value={language} onValueChange={(v) => setPrefs({ language: v as Language })}>
          <SelectTrigger className="h-8 w-44 border-border bg-card text-[13px] text-foreground">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SUPPORTED_LANGUAGES.map((item) => (
              <SelectItem key={item.code} value={item.code}>
                {t(item.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}

interface VaultManagerDialogProps extends VaultManagerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** The start screen's content in a modal, opened from the vault switcher. */
export function VaultManagerDialog({
  open,
  onOpenChange,
  onSelect,
  onOpenVault,
  ...props
}: VaultManagerDialogProps) {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-4 border-border bg-background p-5 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">{t("vaultPicker.manage")}</DialogTitle>
          <DialogDescription className="sr-only">{t("vaultPicker.manage")}</DialogDescription>
        </DialogHeader>
        <VaultManager
          {...props}
          onSelect={(path) => {
            onOpenChange(false)
            onSelect(path)
          }}
          onOpenVault={() => {
            onOpenChange(false)
            onOpenVault()
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
