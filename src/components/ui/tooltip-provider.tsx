"use client"

import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { useSettingsStore } from "@/components/workspace/use-settings-store"
import { motionTransitions } from "@/lib/motion-config"

import { cn } from "@/lib/utils"

type TooltipSide = "left" | "right" | "top" | "bottom"

let ruler: HTMLDivElement | null = null
function measureTooltip(content: string): { width: number; height: number } {
  if (typeof document === "undefined" || !document.body) {
    const estimated = Math.min(Math.max(content.length * 7.5, 60), 320)
    return { width: estimated, height: 32 }
  }
  if (!ruler) {
    ruler = document.createElement("div")
    ruler.style.position = "fixed"
    ruler.style.left = "-9999px"
    ruler.style.top = "-9999px"
    ruler.style.visibility = "hidden"
    ruler.style.pointerEvents = "none"
    ruler.style.maxWidth = "320px"
    ruler.style.padding = "6px 12px"
    ruler.style.fontSize = "13px"
    ruler.style.fontWeight = "500"
    ruler.style.lineHeight = "1.25rem"
    ruler.style.whiteSpace = "pre-line"
    ruler.style.wordBreak = "break-word"
    ruler.className = "border border-border font-sans"
    document.body.appendChild(ruler)
  }
  ruler.textContent = content
  const rect = ruler.getBoundingClientRect()
  const width = Math.ceil(rect.width) || Math.min(Math.max(content.length * 7.5, 60), 320)
  const height = Math.ceil(rect.height) || 32
  return { width, height }
}

interface TooltipState {
  content: string
  left: number
  top: number
  side: TooltipSide
  arrowStyle: React.CSSProperties
}

const TOOLTIP_GAP = 10
const TOOLTIP_SAFE_WIDTH = 320
const TOOLTIP_DELAY = 1000

/**
 * One visual tooltip system for the application.
 *
 * Existing controls use native `title` attributes, including controls created
 * by Tiptap node views. This provider promotes them to `data-amby-tooltip`,
 * removes the browser tooltip, and renders the shared application tooltip.
 */
export function TooltipProvider() {
  const tooltipDelayMs = useSettingsStore((state) => state.prefs.tooltipDelayMs)
  const [tooltip, setTooltip] = React.useState<TooltipState | null>(null)
  const activeTargetRef = React.useRef<HTMLElement | null>(null)
  const pendingTargetRef = React.useRef<HTMLElement | null>(null)
  const showTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const delayRef = React.useRef(tooltipDelayMs ?? TOOLTIP_DELAY)

  React.useEffect(() => {
    delayRef.current = tooltipDelayMs
  }, [tooltipDelayMs])

  React.useLayoutEffect(() => {
    const promoteTitle = (element: HTMLElement) => {
      const title = element.getAttribute("title")?.trim()
      if (!title) return
      element.dataset.ambyTooltip = title
      element.removeAttribute("title")
      if (
        !element.hasAttribute("aria-label") &&
        element.matches("button, input, select, textarea, [role=button]")
      ) {
        element.setAttribute("aria-label", title)
      }
    }

    const promoteTree = (root: ParentNode) => {
      if (root instanceof HTMLElement) promoteTitle(root)
      root.querySelectorAll?.<HTMLElement>("[title]").forEach(promoteTitle)
    }

    const show = (target: HTMLElement) => {
      const content = target.dataset.ambyTooltip
      if (!content || target.matches(":disabled")) return
      if (delayRef.current < 0) return
      pendingTargetRef.current = target
      if (showTimerRef.current) clearTimeout(showTimerRef.current)
      showTimerRef.current = setTimeout(() => {
        if (pendingTargetRef.current !== target) return
        if (!target.isConnected) return

        activeTargetRef.current = target
        const rect = target.getBoundingClientRect()
        const { width: tipW, height: tipH } = measureTooltip(content)

        const explicitSide = (target.dataset.tooltipSide ??
          target.closest<HTMLElement>("[data-tooltip-side]")?.dataset.tooltipSide) as
          TooltipSide | undefined

        const isActivityButton = Boolean(
          target.closest(".amby-activity-button, [data-activity-button], [data-activity-bar]"),
        )
        const isTreeCount = Boolean(
          target.closest("[data-tree-reorder-target], [data-tree-item-id]"),
        )

        let side: TooltipSide
        if (explicitSide) {
          side = explicitSide
        } else if (isActivityButton) {
          side = rect.left < window.innerWidth / 2 ? "right" : "left"
        } else if (isTreeCount) {
          side =
            rect.right + TOOLTIP_GAP + TOOLTIP_SAFE_WIDTH <= window.innerWidth ? "right" : "left"
        } else {
          const hasSpaceBelow = rect.bottom + TOOLTIP_GAP + 60 <= window.innerHeight
          const hasSpaceAbove = rect.top - TOOLTIP_GAP >= 40
          if (!hasSpaceBelow && hasSpaceAbove) {
            side = "top"
          } else {
            side = "bottom"
          }
        }

        const targetCenterX = rect.left + rect.width / 2
        const targetCenterY = rect.top + rect.height / 2

        let left: number
        let top: number
        let arrowStyle: React.CSSProperties

        if (side === "bottom" || side === "top") {
          const minLeft = 12
          const maxLeft = Math.max(minLeft, window.innerWidth - 12 - tipW)
          const idealLeft = targetCenterX - tipW / 2
          left = Math.max(minLeft, Math.min(maxLeft, idealLeft))
          top = side === "bottom" ? rect.bottom + TOOLTIP_GAP : rect.top - TOOLTIP_GAP - tipH

          const arrowLeft = Math.max(10, Math.min(tipW - 10, targetCenterX - left))
          arrowStyle = {
            left: `${arrowLeft}px`,
            ...(side === "bottom" ? { top: "-4px" } : { bottom: "-4px" }),
          }
        } else {
          const minTop = 12
          const maxTop = Math.max(minTop, window.innerHeight - 12 - tipH)
          const idealTop = targetCenterY - tipH / 2
          top = Math.max(minTop, Math.min(maxTop, idealTop))
          left = side === "right" ? rect.right + TOOLTIP_GAP : rect.left - TOOLTIP_GAP - tipW

          const arrowTop = Math.max(10, Math.min(tipH - 10, targetCenterY - top))
          arrowStyle = {
            top: `${arrowTop}px`,
            ...(side === "right" ? { left: "-4px" } : { right: "-4px" }),
          }
        }

        setTooltip({
          content,
          left,
          top,
          side,
          arrowStyle,
        })
      }, delayRef.current)
    }

    const hide = () => {
      activeTargetRef.current = null
      pendingTargetRef.current = null
      if (showTimerRef.current) clearTimeout(showTimerRef.current)
      showTimerRef.current = null
      setTooltip(null)
    }
    const hideActive = () => {
      activeTargetRef.current = null
      setTooltip(null)
    }

    const getTarget = (event: Event): HTMLElement | null => {
      const source = event.target
      return source instanceof Element ? source.closest<HTMLElement>("[data-amby-tooltip]") : null
    }

    const onPointerOver = (event: PointerEvent) => {
      const target = getTarget(event)
      if (target && target !== activeTargetRef.current) show(target)
    }

    const onPointerOut = (event: PointerEvent) => {
      const target = getTarget(event)
      const next =
        event.relatedTarget instanceof Element
          ? event.relatedTarget.closest<HTMLElement>("[data-amby-tooltip]")
          : null
      if (target && next !== target) {
        if (target === activeTargetRef.current) hideActive()
        if (target === pendingTargetRef.current) {
          pendingTargetRef.current = null
          if (showTimerRef.current) clearTimeout(showTimerRef.current)
          showTimerRef.current = null
        }
      }
    }

    const onFocusIn = (event: FocusEvent) => {
      const target = getTarget(event)
      if (!target) return
      const focusedEl = event.target instanceof HTMLElement ? event.target : null
      try {
        if (
          focusedEl &&
          (focusedEl.matches(":focus-visible") || target.matches(":focus-visible"))
        ) {
          show(target)
        }
      } catch {
        // :focus-visible might throw or be unsupported in test DOM environments
      }
    }
    const onFocusOut = () => hide()
    const dismissOnInteraction = () => hide()
    const dismissWhenHidden = () => {
      if (document.visibilityState !== "visible") hide()
    }
    const reposition = () => {
      if (activeTargetRef.current) show(activeTargetRef.current)
    }

    promoteTree(document)
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes" && record.target instanceof HTMLElement)
          promoteTitle(record.target)
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement) promoteTree(node)
        }
        for (const node of record.removedNodes) {
          if (
            node instanceof HTMLElement &&
            activeTargetRef.current &&
            (node === activeTargetRef.current || node.contains(activeTargetRef.current))
          ) {
            hide()
          }
        }
      }
    })
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["title"],
    })
    document.addEventListener("pointerover", onPointerOver)
    document.addEventListener("pointerout", onPointerOut)
    document.addEventListener("pointerdown", dismissOnInteraction, true)
    document.addEventListener("focusin", onFocusIn)
    document.addEventListener("focusout", onFocusOut)
    document.addEventListener("keydown", dismissOnInteraction, true)
    document.addEventListener("visibilitychange", dismissWhenHidden)
    document.addEventListener("mouseleave", hide)
    window.addEventListener("blur", dismissOnInteraction)
    window.addEventListener("resize", reposition)
    window.addEventListener("scroll", hide, true)

    return () => {
      observer.disconnect()
      document.removeEventListener("pointerover", onPointerOver)
      document.removeEventListener("pointerout", onPointerOut)
      document.removeEventListener("pointerdown", dismissOnInteraction, true)
      document.removeEventListener("focusin", onFocusIn)
      document.removeEventListener("focusout", onFocusOut)
      document.removeEventListener("keydown", dismissOnInteraction, true)
      document.removeEventListener("visibilitychange", dismissWhenHidden)
      document.removeEventListener("mouseleave", hide)
      window.removeEventListener("blur", dismissOnInteraction)
      window.removeEventListener("resize", reposition)
      window.removeEventListener("scroll", hide, true)
    }
  }, [])

  return (
    <AnimatePresence>
      {tooltip && (
        <motion.div
          key={`${tooltip.content}:${tooltip.left}:${tooltip.top}`}
          role="tooltip"
          className="pointer-events-none fixed z-[100] max-w-[320px] break-words whitespace-pre-line rounded-lg border border-border bg-popover px-3 py-1.5 text-[13px] font-medium text-foreground shadow-xl"
          initial={{
            opacity: 0,
            y: tooltip.side === "bottom" ? -4 : tooltip.side === "top" ? 4 : 0,
            x: tooltip.side === "right" ? -4 : tooltip.side === "left" ? 4 : 0,
          }}
          animate={{
            opacity: 1,
            y: 0,
            x: 0,
          }}
          exit={{
            opacity: 0,
            y: tooltip.side === "bottom" ? -4 : tooltip.side === "top" ? 4 : 0,
            x: tooltip.side === "right" ? -4 : tooltip.side === "left" ? 4 : 0,
          }}
          transition={motionTransitions.enter}
          style={{ left: tooltip.left, top: tooltip.top }}
        >
          <span
            className={cn(
              "absolute size-2 rotate-45 border-border bg-popover",
              tooltip.side === "right" && "border-b border-l -translate-y-1/2",
              tooltip.side === "left" && "border-r border-t -translate-y-1/2",
              tooltip.side === "bottom" && "border-l border-t -translate-x-1/2",
              tooltip.side === "top" && "border-r border-b -translate-x-1/2",
            )}
            style={tooltip.arrowStyle}
          />
          {tooltip.content}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
