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
    target?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, 250)
}
