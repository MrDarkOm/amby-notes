"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { Check, ChevronDown, SlidersHorizontal } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { ProviderIcon } from "./provider-icon"

export interface PickerModel {
  value: string
  label: string
  providerId: string
  /** The provider's own id of the model, for the mark of its family. */
  modelId?: string
  groupId?: string
  providerLabel: string
  kind: "local" | "cloud"
}

const MAX_SHORTCUTS = 9

/** "⌘3" on a Mac, "Ctrl+3" elsewhere: the way the key is written on the keyboard. */
function shortcutLabel(position: number): string {
  const mac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)
  return mac ? `⌘${position}` : `Ctrl+${position}`
}

/**
 * The model list as a small two-column menu: the providers you have models for on a rail at the
 * left, that provider's models at the right, each with Mod+1…9 to pick it while the list is open.
 */
export function ModelPicker({
  models,
  activeModelId,
  onModel,
  onManage,
  menu,
}: {
  models: PickerModel[]
  activeModelId: string
  onModel: (id: string) => void
  onManage: () => void
  /**
   * Given when a parent `Popover` with its own `PopoverAnchor` hosts the list (so it is as wide as
   * that anchor and opens above it); without it the picker is a popover of its own.
   */
  menu?: {
    open: boolean
    onOpenChange: (open: boolean) => void
    /** The panel's width and where its left edge is, relative to the anchor, when measured. */
    width?: number
    alignOffset?: number
  }
}) {
  const { t } = useTranslation()
  const active = models.find((model) => model.value === activeModelId)
  const groups = React.useMemo(() => {
    const seen = new Map<
      string,
      { id: string; providerId: string; label: string; kind: "local" | "cloud" }
    >()
    for (const model of models)
      if (!seen.has(model.groupId ?? model.providerId))
        seen.set(model.groupId ?? model.providerId, {
          id: model.groupId ?? model.providerId,
          providerId: model.providerId,
          label: model.providerLabel,
          kind: model.kind,
        })
    return Array.from(seen.values())
  }, [models])
  const [ownOpen, setOwnOpen] = React.useState(false)
  const open = menu ? menu.open : ownOpen
  const setOpen = menu ? menu.onOpenChange : setOwnOpen
  const [groupId, setGroupId] = React.useState(
    active?.groupId ?? active?.providerId ?? groups[0]?.id ?? "",
  )
  const group = groups.find((candidate) => candidate.id === groupId) ?? groups[0]
  const items = models.filter((model) => (model.groupId ?? model.providerId) === group?.id)
  const listRef = React.useRef<HTMLDivElement>(null)

  const pick = (id: string) => {
    setOpen(false)
    if (id !== activeModelId) onModel(id)
  }
  const focusOption = (from: Element | null, step: 1 | -1) => {
    const options = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [],
    )
    if (options.length === 0) return
    const index = from ? options.indexOf(from as HTMLElement) : -1
    options[(index + step + options.length) % options.length]?.focus()
  }

  React.useEffect(() => {
    if (open) setGroupId(active?.groupId ?? active?.providerId ?? groups[0]?.id ?? "")
    // Only on opening: choosing a rail tab must not jump back to the active provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const body = (
    <>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-label={t("ai.activeModel")}
          aria-haspopup="listbox"
          aria-expanded={open}
          title={t("ai.activeModel")}
          className="flex h-7 w-full min-w-0 items-center justify-between gap-1.5 rounded-md bg-transparent px-1.5 text-left text-xs text-muted-foreground outline-none hover:bg-accent/50 focus-visible:ring-1 focus-visible:ring-ring"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {active && (
              <ProviderIcon
                providerId={active.providerId}
                modelId={active.modelId}
                kind={active.kind}
                label={active.providerLabel}
              />
            )}
            <span className="truncate">
              {active?.label ?? t(models.length ? "ai.selectModel" : "ai.noModelsOpenSettings")}
            </span>
          </span>
          <ChevronDown
            aria-hidden="true"
            className={cn("size-3.5 shrink-0", !open && "rotate-180")}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={6}
        alignOffset={menu?.alignOffset ?? 0}
        style={menu?.width && menu.width > 0 ? { width: menu.width } : undefined}
        className={cn(
          "flex min-h-[15rem] max-h-[min(28rem,var(--radix-popover-content-available-height))] gap-0 rounded-xl p-0 shadow-md",
          menu
            ? "w-[var(--radix-popover-trigger-width)] max-w-none"
            : "w-auto max-w-[min(22rem,90vw)]",
        )}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          const selected = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
          ;(selected ?? listRef.current?.querySelector<HTMLElement>('[role="option"]'))?.focus()
        }}
      >
        {groups.length > 1 && (
          <div
            role="tablist"
            aria-orientation="vertical"
            className="flex shrink-0 flex-col gap-1 border-r border-border p-1.5"
          >
            {groups.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                role="tab"
                aria-selected={candidate.id === group?.id}
                aria-label={candidate.label}
                title={candidate.label}
                onClick={() => setGroupId(candidate.id)}
                className={cn(
                  "flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground",
                  candidate.id === group?.id && "bg-accent text-foreground",
                )}
              >
                <ProviderIcon
                  providerId={candidate.providerId}
                  kind={candidate.kind}
                  className="size-[18px]"
                />
              </button>
            ))}
          </div>
        )}
        <div className="flex min-w-[11rem] flex-1 flex-col p-2">
          {group && (
            <div className="px-2 pb-1 pt-0.5 text-[11px] text-muted-foreground">{group.label}</div>
          )}
          <div
            ref={listRef}
            role="listbox"
            aria-label={t("ai.activeModel")}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto"
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
                const model = items[Number(event.key) - 1]
                if (model) {
                  event.preventDefault()
                  pick(model.value)
                }
                return
              }
              if (event.key === "ArrowDown") focusOption(document.activeElement, 1)
              else if (event.key === "ArrowUp") focusOption(document.activeElement, -1)
              else return
              event.preventDefault()
            }}
          >
            {items.map((model, index) => (
              <button
                key={model.value}
                type="button"
                role="option"
                aria-selected={model.value === activeModelId}
                onClick={() => pick(model.value)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left text-[13px] outline-none hover:bg-accent focus-visible:bg-accent",
                  model.value === activeModelId && "bg-accent/60",
                )}
              >
                <ProviderIcon
                  providerId={model.providerId}
                  modelId={model.modelId}
                  kind={model.kind}
                  className="text-muted-foreground"
                />
                <span className="min-w-0 flex-1 truncate">{model.label}</span>
                {index < MAX_SHORTCUTS && (
                  <kbd className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-sans text-[11px] text-muted-foreground">
                    {shortcutLabel(index + 1)}
                  </kbd>
                )}
                {model.value === activeModelId && (
                  <Check className="size-4 shrink-0 text-primary" />
                )}
              </button>
            ))}
          </div>
          <div className="mt-auto border-t border-border pt-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                onManage()
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <SlidersHorizontal className="size-3.5" aria-hidden="true" />
              {t("ai.manageModels")}
            </button>
          </div>
        </div>
      </PopoverContent>
    </>
  )
  return menu ? (
    body
  ) : (
    <Popover open={open} onOpenChange={setOpen}>
      {body}
    </Popover>
  )
}
