import MarkdownIt from "markdown-it"

declare const safeReadonlyHtml: unique symbol

/** HTML emitted only by the raw-HTML-disabled read-only Markdown renderer. */
export type SafeReadonlyHtml = string & { readonly [safeReadonlyHtml]: true }

// Raw HTML is deliberately disabled before this value is used by a NodeView.
const readonlyRenderer = new MarkdownIt("default", { html: false, linkify: false, breaks: false })

export function markdownToSafeReadonlyHtml(markdown: string): SafeReadonlyHtml {
  return readonlyRenderer.render(markdown ?? "") as SafeReadonlyHtml
}
