import stylesheetText from "@/themes/emoji-mart-base.css?inline"
import stylesheetUrl from "@/themes/emoji-mart-base.css?url"

let sharedSheet: CSSStyleSheet | undefined

export function installPickerStyles(root: ShadowRoot) {
  if (
    typeof CSSStyleSheet === "undefined" ||
    typeof CSSStyleSheet.prototype.replaceSync !== "function" ||
    !root.adoptedStyleSheets
  ) {
    return installPickerLink(root)
  }

  // Adopt the bundled stylesheet directly so WebKit can retain it when the
  // picker moves between the parking place and the visible popover.
  if (!sharedSheet) {
    sharedSheet = new CSSStyleSheet()
    sharedSheet.replaceSync(stylesheetText)
  }
  const sheet = sharedSheet
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet]
  return {
    afterMove: () => {},
    dispose() {
      root.adoptedStyleSheets = root.adoptedStyleSheets.filter((current) => current !== sheet)
    },
  }
}

/** Older engines load a local link after Mart's asynchronous first render. */
function installPickerLink(root: ShadowRoot) {
  let stylesheet: HTMLLinkElement | undefined
  const install = () => {
    if (!root.querySelector("#root")) return false
    // An external local stylesheet works with the packaged app's CSP, including
    // configurations where hash/nonce sources disable unsafe-inline styles.
    stylesheet = root.ownerDocument.createElement("link")
    stylesheet.dataset.ambyEmojiMartBase = "true"
    stylesheet.rel = "stylesheet"
    stylesheet.href = stylesheetUrl
    root.append(stylesheet)
    return true
  }

  // Observe only initial root creation, never scrolling, searches or the emoji subtree.
  const observer = new MutationObserver(() => {
    if (install()) observer.disconnect()
  })
  if (!install()) observer.observe(root, { childList: true })

  return {
    // Moving the host can cancel a WebKit shadow-root stylesheet load. A fresh
    // link starts loading in the connected host without rebuilding the picker.
    afterMove() {
      if (!stylesheet) return
      stylesheet.remove()
      install()
    },
    dispose: () => observer.disconnect(),
  }
}
