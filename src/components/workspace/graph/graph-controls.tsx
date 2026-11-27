"use client"

import { useTranslation } from "react-i18next"
import { LocateFixed, MoreVertical, Play, RefreshCw, RotateCcw, Settings2 } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { GraphSettings } from "./graph-settings"

type ToggleKey = "showTags" | "showAttachments" | "existingOnly" | "showOrphans" | "showArrows"

const TOGGLES: Array<{ key: ToggleKey; label: string }> = [
  { key: "showTags", label: "graph.settings.tags" },
  { key: "showAttachments", label: "graph.settings.attachments" },
  { key: "existingOnly", label: "graph.settings.existingOnly" },
  { key: "showOrphans", label: "graph.settings.orphans" },
  { key: "showArrows", label: "graph.settings.arrows" },
]

interface GraphMoreMenuProps {
  settings: GraphSettings
  locked: boolean
  onChange: (patch: Partial<GraphSettings>) => void
  onFit: () => void
  onRefresh?: () => void
  onAnimate: () => void
  onOpenSettings: () => void
  onReset: () => void
}

/** The "⋮" menu at the top right of the graph, where every note keeps its own. */
export function GraphMoreMenu({
  settings,
  locked,
  onChange,
  onFit,
  onRefresh,
  onAnimate,
  onOpenSettings,
  onReset,
}: GraphMoreMenuProps) {
  const { t } = useTranslation()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={t("graph.more")}
          aria-label={t("graph.more")}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
        >
          <MoreVertical className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60 border-border bg-popover text-foreground">
        <DropdownMenuLabel className="text-[11px] text-muted-foreground">
          {t("graph.settings.filters")}
        </DropdownMenuLabel>
        {TOGGLES.map(({ key, label }) => (
          <DropdownMenuCheckboxItem
            key={key}
            checked={settings[key]}
            // Keep the menu open so several switches can be flipped in a row.
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) => onChange({ [key]: checked === true })}
            className="text-[13px]"
          >
            {t(label)}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onFit} className="text-[13px]">
          <LocateFixed className="size-3.5" />
          {t("graph.fit")}
        </DropdownMenuItem>
        {onRefresh ? (
          <DropdownMenuItem onSelect={onRefresh} className="text-[13px]">
            <RefreshCw className="size-3.5" />
            {t("graph.refresh")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem disabled={locked} onSelect={onAnimate} className="text-[13px]">
          <Play className="size-3.5" />
          {t("graph.settings.animate")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onOpenSettings} className="text-[13px]">
          <Settings2 className="size-3.5" />
          {t("graph.allSettings")}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={onReset}
          className="text-[13px] text-destructive focus:text-destructive"
        >
          <RotateCcw className="size-3.5" />
          {t("graph.settings.reset")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Asks before every graph setting returns to its default. */
export function GraphResetDialog({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation()
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="w-80 border-border bg-popover p-4 text-foreground sm:max-w-sm"
      >
        <DialogTitle className="text-[14px] font-semibold">
          {t("graph.resetConfirm.title")}
        </DialogTitle>
        <DialogDescription className="text-[13px] leading-snug text-muted-foreground">
          {t("graph.resetConfirm.body")}
        </DialogDescription>
        <div className="mt-1 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-accent"
            onClick={onCancel}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            autoFocus
            className="rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-white hover:bg-destructive/90"
            onClick={onConfirm}
          >
            {t("graph.resetConfirm.confirm")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
