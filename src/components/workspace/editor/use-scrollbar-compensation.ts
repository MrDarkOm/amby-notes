import * as React from "react"

/**
 * Keeps the note from shifting sideways when its scrollbar comes and goes.
 *
 * The scrollbar takes width from the content, so a note that grows past the window
 * (a database turning into a gallery, one more line of text) moves its title and
 * text to the left by half of it. Reserving the space with `scrollbar-gutter` is not
 * honored everywhere, so the scroller says whether it currently has a bar
 * (`data-scrollbar`) and the stylesheet pads the missing bar's width back in.
 */
export function useScrollbarCompensation(ref: React.RefObject<HTMLElement | null>) {
  React.useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const sync = () => {
      // A hidden layer has no size; keep what was last known.
      if (element.clientHeight === 0) return
      const next = element.scrollHeight > element.clientHeight + 1 ? "on" : "off"
      if (element.dataset.scrollbar !== next) element.dataset.scrollbar = next
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(element)
    // The content decides whether there is anything to scroll.
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    return () => observer.disconnect()
  }, [ref])
}
