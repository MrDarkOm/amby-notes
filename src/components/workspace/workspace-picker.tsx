"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { Check, FolderOpen, Settings2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

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
  /** Opens the native dialog to pick or create a vault. */
  onAdd: () => void
  /** Opens the vault manager modal. */
  onManage: () => void
}

const ACTION =
  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-[13px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent"

export function WorkspacePicker({
  children,
  vaults,
  currentPath,
  onSelect,
  onAdd,
  onManage,
}: WorkspacePickerProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-56 border-border bg-popover p-1 shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex max-h-56 flex-col overflow-y-auto">
          {vaults.length === 0 && (
            <p className="px-2 py-1.5 text-[12px] text-muted-foreground">
              {t("vaultPicker.noVaults")}
            </p>
          )}
          {vaults.map((vault) => (
            <button
              key={vault.id}
              type="button"
              title={vault.path}
              onClick={() => {
                onSelect(vault.path)
                setOpen(false)
              }}
              className={cn(
                "flex items-center gap-2 rounded px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent",
                vault.path === currentPath && "bg-accent/60",
              )}
            >
              <span className="flex size-3.5 shrink-0 items-center justify-center">
                {vault.path === currentPath && <Check className="size-3 text-foreground" />}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                {vault.name}
              </span>
            </button>
          ))}
        </div>

        <div className="mt-1 border-t border-border pt-1">
          <button
            type="button"
            onClick={() => {
              onAdd()
              setOpen(false)
            }}
            className={ACTION}
          >
            <FolderOpen className="size-3.5" />
            {t("vaultPicker.choose")}
          </button>
          <button
            type="button"
            onClick={() => {
              onManage()
              setOpen(false)
            }}
            className={ACTION}
          >
            <Settings2 className="size-3.5" />
            {t("vaultPicker.manage")}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
