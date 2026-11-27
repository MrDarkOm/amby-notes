import * as React from "react"

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'

function tabbables(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (element) => !(element as HTMLButtonElement).disabled,
  )
}

/**
 * Focus handling for a modal window that cannot be a Radix `Dialog` (its body hosts an editor whose
 * popups live outside it, and Radix would make those inert): focus moves in when it opens, Tab stays
 * inside, and focus goes back to the element that had it before the window opened.
 */
export function useDialogFocus(ref: React.RefObject<HTMLElement | null>, enabled: boolean) {
  React.useEffect(() => {
    const root = ref.current
    if (!enabled || !root) return
    const opener = document.activeElement as HTMLElement | null
    if (!root.contains(document.activeElement)) {
      ;(tabbables(root)[0] ?? root).focus()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return
      const items = tabbables(root)
      if (items.length === 0) {
        event.preventDefault()
        root.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || active === root)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      } else if (!root.contains(active)) {
        event.preventDefault()
        first.focus()
      }
    }
    root.addEventListener("keydown", onKeyDown)
    return () => {
      root.removeEventListener("keydown", onKeyDown)
      if (opener?.isConnected) opener.focus()
    }
  }, [ref, enabled])
}
