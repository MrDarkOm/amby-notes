"use client"

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { motion } from "motion/react"
import { useTranslation } from "react-i18next"
import {
  ArrowUpRight,
  BookOpen,
  Files,
  FolderOpen,
  Keyboard,
  Map as MapIcon,
  MousePointer2,
  PanelRight,
  PanelsTopLeft,
  Settings2,
  Sparkles,
  X,
} from "lucide-react"
import {
  Dialog,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog"
import { motionTransitions } from "@/lib/motion-config"
import { cn } from "@/lib/utils"
import { formatShortcut, matchesShortcut } from "./keyboard-shortcuts"
import { useSettingsStore } from "./use-settings-store"
import { HELP_GROUPS } from "./help-targets"
import { helpConnector, helpOverlayLayout, type HelpRect } from "./help-overlay-layout"
import { useHelpTargets } from "./use-help-targets"
import { HelpShortcuts } from "./help-shortcuts"

export type HelpContext = "note" | "canvas" | "sketch" | "database" | "workspace"
export interface HelpModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialContext?: HelpContext
}

const GROUP_ICONS = {
  tabs: PanelsTopLeft,
  panels: MapIcon,
  files: Files,
  workspace: FolderOpen,
  page: ArrowUpRight,
  editor: BookOpen,
  context: PanelRight,
  tools: Settings2,
}
const MotionContent = motion.create(DialogPrimitive.Content)

export function HelpModal({ open, onOpenChange, initialContext = "workspace" }: HelpModalProps) {
  const { t } = useTranslation()
  const { width, height, targets } = useHelpTargets(open)
  const bindings = useSettingsStore((state) => state.prefs.shortcuts)
  const [activeId, setActiveId] = React.useState<string | null>(null)
  const [cardRects, setCardRects] = React.useState<Record<string, HelpRect>>({})
  const cardRefs = React.useRef(new Map<string, HTMLElement>())
  const markerId = React.useId().replace(/:/g, "")
  const maskId = `${markerId}-mask`
  const mode = helpOverlayLayout(width, height)
  const detailId = React.useId()
  const closeRef = React.useRef<HTMLButtonElement>(null)
  const returnFocusRef = React.useRef<HTMLElement | null>(null)
  const active = targets.find((target) => target.id === activeId)
  const groups = HELP_GROUPS.map((definition, index) => ({
    ...definition,
    number: String(index + 1).padStart(2, "0"),
    targets: targets.filter((target) => target.group === definition.id),
  }))
    .filter((group) => group.targets.length)
    .map((group) => {
      const target = group.targets[0].rect
      const x = target.left + target.width / 2
      return { ...group, side: x < width * 0.3 ? "left" : x > width * 0.7 ? "right" : group.side }
    })
  const targetDescription = (id: string) =>
    t(
      id === "content"
        ? `help.guide.content.${initialContext}`
        : `help.guide.tips.${id}.description`,
    )

  React.useEffect(() => {
    if (!open) setActiveId(null)
  }, [open])
  React.useLayoutEffect(() => {
    if (!open) return
    const measure = () => {
      const next: Record<string, HelpRect> = {}
      for (const [id, element] of cardRefs.current) {
        const rect = element.getBoundingClientRect()
        // Skip cards clipped by their scroll rail.
        const rail = element.closest("[data-help-rail]")?.getBoundingClientRect()
        if (rail && (rect.top < rail.top || rect.bottom > rail.bottom)) continue
        next[id] = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      }
      setCardRects(next)
    }
    const observer = new ResizeObserver(measure)
    for (const element of cardRefs.current.values()) observer.observe(element)
    measure()
    const rails = document.querySelectorAll("[data-help-rail]")
    rails.forEach((rail) => rail.addEventListener("scroll", measure))
    return () => {
      observer.disconnect()
      rails.forEach((rail) => rail.removeEventListener("scroll", measure))
    }
  }, [open, width, height, targets, mode])

  const renderGroups = (side: "left" | "right") =>
    groups
      .filter((group) => group.side === side)
      .map((group) => {
        const Icon = GROUP_ICONS[group.icon]
        return (
          <section
            key={group.id}
            ref={(element) => {
              if (element) cardRefs.current.set(group.id, element)
              else cardRefs.current.delete(group.id)
            }}
            className={cn(
              "amby-help-group",
              active?.group === group.id && "amby-help-group-active",
            )}
            data-help-group={group.id}
            aria-label={t(`help.guide.groups.${group.id}`)}
          >
            <div className="amby-help-group-heading">
              <span className="amby-help-group-number">{group.number}</span>
              <Icon size={15} aria-hidden="true" />
              <h2>{t(`help.guide.groups.${group.id}`)}</h2>
            </div>
            <div className="amby-help-group-actions">
              {group.targets.map((target) => (
                <div key={target.id}>
                  <button
                    type="button"
                    data-help-tip={target.id}
                    className="amby-help-tip"
                    aria-pressed={activeId === target.id}
                    onPointerEnter={(event) => {
                      if (event.pointerType !== "touch") setActiveId(target.id)
                    }}
                    onFocus={() => setActiveId(target.id)}
                    onClick={() => setActiveId(target.id)}
                    aria-describedby={`${detailId}-${target.id}`}
                  >
                    <span>{t(`help.guide.tips.${target.id}.title`)}</span>
                    <ArrowUpRight size={12} aria-hidden="true" />
                  </button>
                  <div
                    id={`${detailId}-${target.id}`}
                    className="amby-help-inline-detail"
                    data-active={activeId === target.id}
                  >
                    <p>{targetDescription(target.id)}</p>
                    {target.shortcut && <kbd>{formatShortcut(bindings[target.shortcut])}</kbd>}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )
      })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay className="amby-help-backdrop bg-transparent" />
        <MotionContent
          data-help-screen
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            const previous = document.activeElement
            returnFocusRef.current =
              previous instanceof HTMLElement && previous !== document.body
                ? previous
                : document.querySelector<HTMLElement>('[data-activity-button="help"]')
            closeRef.current?.focus()
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (returnFocusRef.current?.isConnected)
              returnFocusRef.current.focus({ preventScroll: true })
            document
              .querySelector<HTMLElement>('[data-activity-button="help"]')
              ?.focus({ preventScroll: true })
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") return
            event.stopPropagation()
            if (Object.values(bindings).some((binding) => matchesShortcut(event, binding)))
              event.preventDefault()
          }}
          data-layout={mode}
          className="amby-help-screen"
          style={{ pointerEvents: "none" }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={motionTransitions.enter}
        >
          <svg className="amby-help-canvas" width={width} height={height} aria-hidden="true">
            <defs>
              <marker
                id={markerId}
                markerWidth="7"
                markerHeight="7"
                refX="6"
                refY="3.5"
                orient="auto"
                markerUnits="userSpaceOnUse"
              >
                <path d="M1 1 L6 3.5 L1 6" className="amby-help-arrowhead" />
              </marker>
              <mask id={maskId}>
                <rect width="100%" height="100%" className="amby-help-mask-base" />
                {active && (
                  <rect
                    x={active.rect.left - 4}
                    y={active.rect.top - 4}
                    width={active.rect.width + 8}
                    height={active.rect.height + 8}
                    rx={9}
                    className="amby-help-mask-hole"
                  />
                )}
              </mask>
            </defs>
            <rect width="100%" height="100%" className="amby-help-scrim" mask={`url(#${maskId})`} />
            {mode === "spacious" &&
              groups.map((group) => {
                const target = active?.group === group.id ? active : group.targets[0]
                const card = cardRects[group.id]
                if (!card) return null
                const path = helpConnector(card, target.rect)
                const selected = active?.id === target.id
                return (
                  <g
                    key={group.id}
                    className={cn(
                      "amby-help-connector",
                      active && !selected && "amby-help-connector-muted",
                      selected && "amby-help-connector-active",
                    )}
                  >
                    {path && <path d={path} markerEnd={`url(#${markerId})`} />}
                    {path && (
                      <rect
                        x={target.rect.left - 3}
                        y={target.rect.top - 3}
                        width={target.rect.width + 6}
                        height={target.rect.height + 6}
                        rx={8}
                        className="amby-help-target-outline"
                      />
                    )}
                  </g>
                )
              })}
            {active && (
              <rect
                data-help-highlight={active.id}
                x={active.rect.left - 4}
                y={active.rect.top - 4}
                width={active.rect.width + 8}
                height={active.rect.height + 8}
                rx={9}
                className="amby-help-highlight"
              />
            )}
          </svg>
          <div className="amby-help-composition">
            <aside
              className="amby-help-rail amby-help-rail-left"
              data-help-rail
              aria-label={t("help.guide.navigation")}
            >
              {renderGroups("left")}
            </aside>
            <section className="amby-help-center">
              <header className="amby-help-header">
                <div className="amby-help-eyebrow">
                  <Sparkles size={13} aria-hidden="true" />
                  {t("help.guide.eyebrow")}
                </div>
                <DialogTitle className="amby-help-title">{t("help.guide.title")}</DialogTitle>
                <DialogDescription className="sr-only">
                  {t("help.guide.description")}
                </DialogDescription>
                <DialogPrimitive.Close
                  ref={closeRef}
                  className="amby-help-close"
                  aria-label={t("common.close")}
                >
                  <X size={17} />
                </DialogPrimitive.Close>
              </header>
              <HelpShortcuts key={initialContext} context={initialContext} />
              <div
                className={cn("amby-help-detail", active && "amby-help-detail-active")}
                data-help-detail
              >
                <div className="amby-help-detail-icon">
                  {active ? <MousePointer2 size={17} /> : <MapIcon size={17} />}
                </div>
                <div>
                  <h2>
                    {active
                      ? t(`help.guide.tips.${active.id}.title`)
                      : t("help.guide.exploreTitle")}
                  </h2>
                  <p>
                    {active ? targetDescription(active.id) : t("help.guide.exploreDescription")}
                  </p>
                  {active?.shortcut && <kbd>{formatShortcut(bindings[active.shortcut])}</kbd>}
                </div>
              </div>
              <footer className="amby-help-footer">
                <span>
                  <Keyboard size={13} aria-hidden="true" />
                  {t("help.guide.customShortcuts")}
                </span>
                <DialogPrimitive.Close className="amby-help-dismiss">
                  <kbd>{t("help.guide.escapeKey")}</kbd>
                  {t("help.guide.close")}
                </DialogPrimitive.Close>
              </footer>
            </section>
            <aside
              className="amby-help-rail amby-help-rail-right"
              data-help-rail
              aria-label={t("help.guide.pageTools")}
            >
              {renderGroups("right")}
            </aside>
          </div>
        </MotionContent>
      </DialogPortal>
    </Dialog>
  )
}
