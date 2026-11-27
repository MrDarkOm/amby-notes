import { animate } from "motion/react"

import { motionTransitions } from "@/lib/motion-config"

export const REVEAL_ANCHOR_EVENT = "amby:reveal-markdown-anchor"

function scrollContainerFor(element: HTMLElement): HTMLElement {
  let parent = element.parentElement
  while (parent) {
    const overflowY = window.getComputedStyle(parent).overflowY
    if (/auto|scroll/.test(overflowY) && parent.scrollHeight > parent.clientHeight) return parent
    parent = parent.parentElement
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement
}

function motionScrollIntoView(target: HTMLElement): void {
  const container = scrollContainerFor(target)
  const containerTop =
    container === document.scrollingElement ? 0 : container.getBoundingClientRect().top
  const targetTop = target.getBoundingClientRect().top - containerTop + container.scrollTop
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    container.scrollTop = targetTop
    return
  }
  animate(container.scrollTop, targetTop, {
    ...motionTransitions.slow,
    onUpdate: (value) => {
      container.scrollTop = value
    },
  })
}

/** Schedule navigation after the current editor has rendered its document. */
export function scrollEditorToAnchor(anchor: string | null, noteId?: string): void {
  if (!anchor) return
  setTimeout(() => {
    const scope = noteId
      ? Array.from(document.querySelectorAll<HTMLElement>("[data-note-id]")).find(
          (area) => area.dataset.noteId === noteId && !area.closest('[aria-hidden="true"]'),
        )
      : document
    if (!scope) return
    const source = scope.querySelector<HTMLElement>(".amby-source-editor")
    if (source) {
      source.dispatchEvent(new CustomEvent("amby:navigate-markdown-anchor", { detail: anchor }))
      return
    }
    const prose = scope.querySelector<HTMLElement>(".obsidian-reading-view, .amby-tiptap-prose")
    if (!prose) return
    const target = anchor.startsWith("#")
      ? Array.from(prose.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")).find(
          (heading) =>
            heading.textContent?.trim().toLowerCase() === anchor.slice(1).trim().toLowerCase(),
        )
      : (Array.from(prose.querySelectorAll<HTMLElement>("[data-block-id]")).find(
          (block) => block.dataset.blockId?.toLowerCase() === anchor.slice(1).toLowerCase(),
        ) ??
        Array.from(prose.querySelectorAll<HTMLElement>("p, li, blockquote")).find((block) =>
          block.textContent
            ?.trimEnd()
            .toLowerCase()
            .endsWith(` ^${anchor.slice(1).toLowerCase()}`),
        ))
    if (!target) return
    target.dispatchEvent(new CustomEvent(REVEAL_ANCHOR_EVENT, { bubbles: true }))
    const scrollTarget = target.hasAttribute("data-note-page-hidden")
      ? Array.from(prose.children).find(
          (child): child is HTMLElement =>
            child instanceof HTMLElement && !child.hasAttribute("data-note-page-hidden"),
        )
      : target
    if (scrollTarget) motionScrollIntoView(scrollTarget)
  }, 250)
}
