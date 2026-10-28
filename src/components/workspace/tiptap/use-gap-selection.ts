import * as React from "react"
import type { Editor } from "@tiptap/react"
import { TextSelection } from "@tiptap/pm/state"
import { isImageLinePos } from "./image-line"
import { isClickInInterlineGap, nearestLinePos } from "./nearest-line"

/** Correct WebKit's gap hit before its native mousedown puts the caret at a line edge. */
export function useGapSelection(
  editor: Editor,
  wrapperRef: React.RefObject<HTMLDivElement | null>,
) {
  React.useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper || editor.isDestroyed) return
    const view = editor.view
    let handledPress = false
    let stopDrag = () => {}

    const onDown = (event: MouseEvent) => {
      stopDrag()
      handledPress = false
      if (
        !editor.isEditable ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.detail > 1 ||
        !(event.target instanceof HTMLElement)
      )
        return
      const target = event.target
      const containerGap = target === view.dom || target.classList.contains("amby-column-content")
      if (!containerGap && !isClickInInterlineGap(view, target, event.clientX, event.clientY))
        return
      const pos = nearestLinePos(view, event.clientY, event.clientX)
      if (pos === null || isImageLinePos(view.state, pos)) return

      event.preventDefault()
      handledPress = true
      const doc = view.state.doc
      const anchor = event.shiftKey ? view.state.selection.anchor : pos
      const select = (head: number) => {
        const selection = TextSelection.between(doc.resolve(anchor), doc.resolve(head))
        if (!selection.eq(view.state.selection))
          view.dispatch(view.state.tr.setSelection(selection).setMeta("pointer", true))
      }
      select(pos)
      view.focus()

      let x = event.clientX
      let y = event.clientY
      let dragging = false
      let frame = 0
      let scrollHost: HTMLElement | null = view.dom.parentElement
      while (scrollHost && !/(auto|scroll)/.test(getComputedStyle(scrollHost).overflowY)) {
        scrollHost = scrollHost.parentElement
      }
      const update = () => {
        if (editor.isDestroyed || view.state.doc !== doc) {
          stopDrag()
          return
        }
        const head = nearestLinePos(view, y, x)
        if (head !== null && !isImageLinePos(view.state, head)) select(head)
      }
      const scroll = () => {
        frame = 0
        if (!scrollHost) return
        const rect = scrollHost.getBoundingClientRect()
        const distance = y < rect.top ? y - rect.top : y > rect.bottom ? y - rect.bottom : 0
        if (distance) {
          scrollHost.scrollTop += Math.max(-24, Math.min(24, distance / 4))
          update()
        }
        if (dragging) frame = requestAnimationFrame(scroll)
      }
      const move = (moveEvent: MouseEvent) => {
        if (!(moveEvent.buttons & 1)) {
          stopDrag()
          return
        }
        x = moveEvent.clientX
        y = moveEvent.clientY
        if (!dragging && Math.hypot(x - event.clientX, y - event.clientY) < 4) return
        dragging = true
        moveEvent.preventDefault()
        update()
        if (!frame) frame = requestAnimationFrame(scroll)
      }
      const end = () => stopDrag()
      stopDrag = () => {
        dragging = false
        cancelAnimationFrame(frame)
        document.removeEventListener("mousemove", move)
        window.removeEventListener("mouseup", end)
        window.removeEventListener("pointercancel", end)
        window.removeEventListener("blur", end)
        stopDrag = () => {}
      }
      document.addEventListener("mousemove", move)
      window.addEventListener("mouseup", end)
      window.addEventListener("pointercancel", end)
      window.addEventListener("blur", end)
    }
    const onClick = (event: MouseEvent) => {
      // A drag ends with a click too; the wrapper's empty-page handler must not collapse it.
      if (!handledPress || event.detail === 0) return
      handledPress = false
      event.preventDefault()
      event.stopPropagation()
    }
    wrapper.addEventListener("mousedown", onDown, true)
    wrapper.addEventListener("click", onClick, true)
    return () => {
      stopDrag()
      wrapper.removeEventListener("mousedown", onDown, true)
      wrapper.removeEventListener("click", onClick, true)
    }
  }, [editor, wrapperRef])
}
