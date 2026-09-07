import { animate } from "motion/react"

import { motionTransitions } from "@/lib/motion-config"

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
export function scrollEditorToAnchor(anchor: string | null): void {
  if (!anchor) return
  setTimeout(() => {
    const source = document.querySelector<HTMLElement>(".amby-source-editor")
    if (source) {
      source.dispatchEvent(new CustomEvent("amby:navigate-markdown-anchor", { detail: anchor }))
      return
    }
    const prose = document.querySelector<HTMLElement>(".obsidian-reading-view, .amby-tiptap-prose")
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
    if (target) motionScrollIntoView(target)
  }, 250)
}
