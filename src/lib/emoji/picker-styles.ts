import stylesheetUrl from "@/themes/emoji-mart-base.css?url"

/** Mart initializes asynchronously and its first render removes constructor styles in WKWebView. */
export function installPickerStyles(root: ShadowRoot): () => void {
  const install = () => {
    if (!root.querySelector("#root")) return false
    if (!root.querySelector("link[data-amby-emoji-mart-base]")) {
      // An external local stylesheet works with the packaged app's CSP, including
      // configurations where hash/nonce sources disable unsafe-inline styles.
      const stylesheet = document.createElement("link")
      stylesheet.dataset.ambyEmojiMartBase = "true"
      stylesheet.rel = "stylesheet"
      stylesheet.href = stylesheetUrl
      root.append(stylesheet)
    }
    return true
  }
  if (install()) return () => {}
  // Observe only initial root creation, never scrolling, searches or the emoji subtree.
  const observer = new MutationObserver(() => {
    if (install()) observer.disconnect()
  })
  observer.observe(root, { childList: true })
  return () => observer.disconnect()
}
