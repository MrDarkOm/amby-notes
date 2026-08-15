import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view"

import { removeEmptyColumnAtSelection } from "./columns-transaction"

const RESIZE_HIT_PX = 14
const MIN_COLUMN_PX = 120
const COLUMN_RESIZE_KEY = new PluginKey<LiveResizeState | null>("ambyColumnResize")

interface LiveResizeState {
  pos: number
  template: string
}

function directColumns(set: HTMLElement): HTMLElement[] {
  return Array.from(set.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.classList.contains("amby-column"),
  )
}

function dividerAt(event: MouseEvent) {
  const target = event.target
  if (!(target instanceof HTMLElement)) return null
  const set = target.closest<HTMLElement>(".amby-column-set")
  if (!set) return null
  const columns = directColumns(set)
  for (let index = 0; index < columns.length - 1; index++) {
    const leftRect = columns[index].getBoundingClientRect()
    const rightRect = columns[index + 1].getBoundingClientRect()
    const edge = (leftRect.right + rightRect.left) / 2
    if (Math.abs(event.clientX - edge) <= RESIZE_HIT_PX) {
      return { set, columns, index }
    }
  }
  return null
}

function columnSetPos(view: EditorView, element: HTMLElement): number | null {
  try {
    const inside = view.posAtDOM(element, 0)
    const pos = inside - 1
    return view.state.doc.nodeAt(pos)?.type.name === "columnSet" ? pos : null
  } catch {
    return null
  }
}

export const ColumnResize = Extension.create({
  name: "columnResize",

  addKeyboardShortcuts() {
    const removeEmptyColumn = () => {
      const { state, dispatch } = this.editor.view
      const tr = removeEmptyColumnAtSelection(state)
      if (!tr) return false
      dispatch(tr.scrollIntoView())
      return true
    }

    return {
      Backspace: removeEmptyColumn,
      Delete: removeEmptyColumn,
    }
  },

  addProseMirrorPlugins() {
    let hoverColumn: HTMLElement | null = null

    function clearHover(view: EditorView) {
      hoverColumn?.classList.remove("is-resize-edge")
      hoverColumn = null
      if (!document.body.classList.contains("amby-resizing-columns")) view.dom.style.cursor = ""
    }

    return [
      new Plugin<LiveResizeState | null>({
        key: COLUMN_RESIZE_KEY,
        state: {
          init: () => null,
          apply(transaction, current) {
            const meta = transaction.getMeta(COLUMN_RESIZE_KEY) as
              LiveResizeState | null | undefined
            if (meta === null) return null
            if (meta !== undefined) return meta
            if (!current) return null
            return { ...current, pos: transaction.mapping.map(current.pos) }
          },
        },
        props: {
          decorations(state) {
            const live = COLUMN_RESIZE_KEY.getState(state)
            if (!live) return null
            const node = state.doc.nodeAt(live.pos)
            if (node?.type.name !== "columnSet") return null
            return DecorationSet.create(state.doc, [
              Decoration.node(live.pos, live.pos + node.nodeSize, {
                class: "is-resizing",
                style: `grid-template-columns: ${live.template} !important`,
              }),
            ])
          },
          handleDOMEvents: {
            mousemove(view, rawEvent) {
              if (!view.editable || document.body.classList.contains("amby-resizing-columns")) {
                return false
              }
              const hit = dividerAt(rawEvent)
              const next = hit?.columns[hit.index + 1] ?? null
              if (hoverColumn !== next) {
                hoverColumn?.classList.remove("is-resize-edge")
                hoverColumn = next
                hoverColumn?.classList.add("is-resize-edge")
              }
              view.dom.style.cursor = hit ? "col-resize" : ""
              return false
            },
            mouseleave(view) {
              clearHover(view)
              return false
            },
            mousedown(view, rawEvent) {
              if (!view.editable || rawEvent.button !== 0) return false
              const hit = dividerAt(rawEvent)
              if (!hit) return false
              const setPos = columnSetPos(view, hit.set)
              const setNode = setPos === null ? null : view.state.doc.nodeAt(setPos)
              if (setPos === null || !setNode) return false

              rawEvent.preventDefault()
              rawEvent.stopPropagation()
              const startX = rawEvent.clientX
              const startWidths = hit.columns.map((column) => column.getBoundingClientRect().width)
              let latestWidths = startWidths.slice()
              const leftStart = startWidths[hit.index]
              const rightStart = startWidths[hit.index + 1]
              const label = document.createElement("div")
              label.className = "amby-column-resize-label"
              label.setAttribute("aria-hidden", "true")
              document.body.appendChild(label)
              const guide = document.createElement("div")
              guide.className = "amby-column-resize-guide"
              guide.setAttribute("aria-hidden", "true")
              document.body.appendChild(guide)
              hit.columns[hit.index].classList.add("is-resizing-before")
              hit.columns[hit.index + 1].classList.add("is-resizing-after")
              document.body.classList.add("amby-resizing-columns")
              hit.set.classList.add("is-resizing")
              const applyWidth = (clientX: number) => {
                const delta = Math.max(
                  MIN_COLUMN_PX - leftStart,
                  Math.min(clientX - startX, rightStart - MIN_COLUMN_PX),
                )
                const next = startWidths.slice()
                next[hit.index] = leftStart + delta
                next[hit.index + 1] = rightStart - delta
                latestWidths = next
                const template = next.map((width) => `${width}px`).join(" ")
                hit.set.style.setProperty("grid-template-columns", template, "important")
                view.dispatch(
                  view.state.tr
                    .setMeta(COLUMN_RESIZE_KEY, { pos: setPos, template } satisfies LiveResizeState)
                    .setMeta("addToHistory", false),
                )
                const total = next.reduce((sum, width) => sum + width, 0) || 1
                const leftPercent = Math.round((next[hit.index] / total) * 100)
                const rightPercent = Math.round((next[hit.index + 1] / total) * 100)
                const liveSet = view.nodeDOM(setPos)
                const setElement = liveSet instanceof HTMLElement ? liveSet : hit.set
                const liveColumns = directColumns(setElement)
                const leftRect = (
                  liveColumns[hit.index] ?? hit.columns[hit.index]
                ).getBoundingClientRect()
                const rightRect = (
                  liveColumns[hit.index + 1] ?? hit.columns[hit.index + 1]
                ).getBoundingClientRect()
                const setRect = setElement.getBoundingClientRect()
                const dividerX = (leftRect.right + rightRect.left) / 2
                label.textContent = `${leftPercent}% · ${rightPercent}%`
                label.style.left = `${dividerX}px`
                label.style.top = `${Math.max(8, setRect.top - 34)}px`
                guide.style.left = `${dividerX}px`
                guide.style.top = `${setRect.top}px`
                guide.style.height = `${setRect.height}px`
              }

              applyWidth(startX)

              let pendingX = startX
              let resizeFrame: number | null = null
              const onMove = (event: MouseEvent | PointerEvent) => {
                pendingX = event.clientX
                if (resizeFrame !== null) return
                resizeFrame = window.requestAnimationFrame(() => {
                  resizeFrame = null
                  applyWidth(pendingX)
                })
              }

              let finished = false
              const onUp = (event: MouseEvent | PointerEvent) => {
                if (finished) return
                finished = true
                if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame)
                applyWidth(event.clientX)
                document.removeEventListener("mousemove", onMove)
                document.removeEventListener("mouseup", onUp)
                document.removeEventListener("pointermove", onMove)
                document.removeEventListener("pointerup", onUp)
                document.removeEventListener("pointercancel", onUp)
                document.body.classList.remove("amby-resizing-columns")
                hit.set.classList.remove("is-resizing")
                hit.columns[hit.index].classList.remove("is-resizing-before")
                hit.columns[hit.index + 1].classList.remove("is-resizing-after")
                label.remove()
                guide.remove()
                const total = latestWidths.reduce((sum, width) => sum + width, 0) || 1
                const widths = latestWidths.map((width) => (width / total).toFixed(4)).join(",")
                const current = view.state.doc.nodeAt(setPos)
                if (current?.type.name === "columnSet") {
                  view.dispatch(
                    view.state.tr
                      .setNodeMarkup(setPos, undefined, { ...current.attrs, widths })
                      .setMeta(COLUMN_RESIZE_KEY, null),
                  )
                } else {
                  view.dispatch(view.state.tr.setMeta(COLUMN_RESIZE_KEY, null))
                }
                clearHover(view)
              }

              document.addEventListener("mousemove", onMove)
              document.addEventListener("mouseup", onUp)
              document.addEventListener("pointermove", onMove)
              document.addEventListener("pointerup", onUp)
              document.addEventListener("pointercancel", onUp)
              return true
            },
          },
        },
      }),
    ]
  },
})
