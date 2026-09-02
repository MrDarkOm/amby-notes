"use client"

import * as React from "react"

interface TooltipState {
  content: string
  left: number
  top: number
  side: "left" | "right"
}

const TOOLTIP_GAP = 10
const TOOLTIP_SAFE_WIDTH = 260
const TOOLTIP_DELAY = 1000
const TOOLTIP_DELAY_KEY = "amby:tooltip-delay-ms"

/**
 * One visual tooltip system for the application.
 *
 * Existing controls use native `title` attributes, including controls created
 * by Tiptap node views. This provider promotes them to `data-amby-tooltip`,
 * removes the browser tooltip, and renders the shared application tooltip.
 */
export function TooltipProvider() {
  const [tooltip, setTooltip] = React.useState<TooltipState | null>(null)
  const activeTargetRef = React.useRef<HTMLElement | null>(null)
  const pendingTargetRef = React.useRef<HTMLElement | null>(null)
  const showTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const delayRef = React.useRef(TOOLTIP_DELAY)

  React.useLayoutEffect(() => {
    const saved = Number(localStorage.getItem(TOOLTIP_DELAY_KEY))
    if (Number.isFinite(saved) && saved >= -1) delayRef.current = saved
    const onDelayChange = () => {
      const next = Number(localStorage.getItem(TOOLTIP_DELAY_KEY))
      if (Number.isFinite(next) && next >= -1) delayRef.current = next
    }
    window.addEventListener("amby:tooltip-delay-change", onDelayChange)
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
        activeTargetRef.current = target
        const rect = target.getBoundingClientRect()
        const side =
          rect.right + TOOLTIP_GAP + TOOLTIP_SAFE_WIDTH <= window.innerWidth ||
          rect.left < TOOLTIP_SAFE_WIDTH
            ? "right"
            : "left"
        setTooltip({
          content,
          left: side === "right" ? rect.right + TOOLTIP_GAP : rect.left - TOOLTIP_GAP,
          top: rect.top + rect.height / 2,
          side,
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
        }
      }
    }
    const onFocusIn = (event: FocusEvent) => {
      const target = getTarget(event)
      if (target) show(target)
    }
    const onFocusOut = () => hide()
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
    document.addEventListener("focusin", onFocusIn)
    document.addEventListener("focusout", onFocusOut)
    window.addEventListener("resize", reposition)
    window.addEventListener("scroll", reposition, true)

    return () => {
      window.removeEventListener("amby:tooltip-delay-change", onDelayChange)
      observer.disconnect()
      document.removeEventListener("pointerover", onPointerOver)
      document.removeEventListener("pointerout", onPointerOut)
      document.removeEventListener("focusin", onFocusIn)
      document.removeEventListener("focusout", onFocusOut)
      window.removeEventListener("resize", reposition)
      window.removeEventListener("scroll", reposition, true)
    }
  }, [])

  if (!tooltip) return null

  return (
    <div
      role="tooltip"
      className={`pointer-events-none fixed z-[100] whitespace-nowrap rounded-lg border border-border bg-popover px-3 py-1.5 text-[13px] font-medium text-foreground shadow-xl ${tooltip.side === "right" ? "amby-tooltip-from-right" : "amby-tooltip-from-left"}`}
      style={{
        left: tooltip.left,
        top: tooltip.top,
      }}
    >
      <span
        className={`absolute top-1/2 size-2 -translate-y-1/2 rotate-45 border-border bg-popover ${
          tooltip.side === "right" ? "-left-1 border-b border-l" : "-right-1 border-r border-t"
        }`}
      />
      {tooltip.content}
    </div>
  )
}
