import { Node, mergeAttributes } from "@tiptap/core"

import i18n from "@/lib/i18n"
import {
  MATH_EDIT_EVENT,
  mathBlockOnEnter,
  mathBlockValue,
  normalizedTex,
  removeEmptyMathBlock,
  selectedMathBlock,
  setMathBlockTex,
  takeOpenRequest,
} from "./math-block"
import { displayMathSource, renderMath } from "./rendered-source"

// Portable Markdown blocks the editor does not rebuild stay atomic in the visual
// document: their raw source is the block and is changed in Source mode. Display math
// (`$$ … $$`) is drawn as a formula over that source; the source itself shows when the
// block is selected, and a click or Enter opens its TeX for writing (math-block.ts).
export const OpaqueMarkdownBlock = Node.create({
  name: "opaqueMarkdownBlock",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      kind: { default: "source" },
      value: { default: "" },
    }
  },

  parseHTML() {
    return [
      {
        tag: "pre[data-amby-opaque-markdown]",
        getAttrs: (node) =>
          node instanceof HTMLElement
            ? {
                kind: node.getAttribute("data-amby-opaque-markdown") ?? "source",
                value: node.textContent ?? "",
              }
            : false,
      },
    ]
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      "pre",
      mergeAttributes(HTMLAttributes, {
        "data-amby-opaque-markdown": node.attrs.kind,
        class: "amby-opaque-markdown",
      }),
      node.attrs.value,
    ]
  },

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        if (!editor.isEditable) return false
        const { state, view } = editor
        const selected = selectedMathBlock(state)
        if (selected === null) return mathBlockOnEnter(state, view.dispatch)
        view.nodeDOM(selected)?.dispatchEvent(new CustomEvent(MATH_EDIT_EVENT))
        return true
      },
    }
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node
      const source = document.createElement("pre")
      source.className = "amby-opaque-markdown"

      // Anything but math is its source text, as `renderHTML` writes it.
      if (node.attrs.kind !== "math") {
        source.setAttribute("data-amby-opaque-markdown", String(node.attrs.kind))
        source.textContent = String(node.attrs.value ?? "")
        return {
          dom: source,
          update(next) {
            if (next.type !== current.type || next.attrs.kind === "math") return false
            current = next
            source.setAttribute("data-amby-opaque-markdown", String(next.attrs.kind))
            source.textContent = String(next.attrs.value ?? "")
            return true
          },
          ignoreMutation: () => true,
        }
      }

      const dom = document.createElement("div")
      dom.className = "amby-math-block"
      dom.setAttribute("data-amby-opaque-markdown", "math")
      const formula = document.createElement("div")
      formula.className = "amby-math-render"
      dom.append(formula, source)

      const draw = () => {
        const value = String(current.attrs.value ?? "")
        source.textContent = value
        dom.classList.remove("is-drawn")
        dom.classList.toggle("is-empty", value === "")
        if (value === "") {
          // A formula that was made and not written yet.
          formula.textContent = i18n.t("editor.math.empty")
          dom.classList.add("is-drawn")
          return
        }
        void renderMath(displayMathSource(value), formula, true).then((drawn) => {
          // The block may have changed while the library was loading.
          if (drawn && String(current.attrs.value ?? "") === value) dom.classList.add("is-drawn")
        })
      }
      draw()

      // The TeX being written: a text area under the formula, which follows it. Nothing
      // of it is in the note until it is applied.
      let writing: { panel: HTMLElement; area: HTMLTextAreaElement; error: HTMLElement } | null =
        null
      const position = () => {
        const pos = getPos()
        return typeof pos === "number" ? pos : null
      }
      const preview = () => {
        if (!writing) return
        const tex = writing.area.value
        writing.error.hidden = true
        if (!tex.trim()) {
          formula.textContent = i18n.t("editor.math.empty")
          return
        }
        void renderMath(tex, formula, true).then((drawn) => {
          if (drawn) dom.classList.add("is-drawn")
        })
      }
      const close = () => {
        if (!writing) return
        const { panel } = writing
        // First, so that the focus leaving the removed text area applies nothing.
        writing = null
        panel.remove()
        dom.classList.remove("is-writing")
        draw()
      }
      /** Leaves the text area without a change; a formula never written is taken away. */
      const cancel = () => {
        close()
        const pos = position()
        if (pos === null || editor.isDestroyed) return
        if (!removeEmptyMathBlock(editor.state, pos, editor.view.dispatch)) {
          editor.commands.setNodeSelection(pos)
        }
        editor.view.focus()
      }
      /** Writes the TeX into the note. False when it stays open: the TeX cannot be held. */
      const apply = (byKey: boolean): boolean => {
        if (!writing) return true
        const tex = normalizedTex(writing.area.value)
        const pos = position()
        if (pos === null || editor.isDestroyed) {
          close()
          return true
        }
        const before = String(current.attrs.value ?? "")
        // Nothing written, or nothing changed: the block stays as it is, byte for byte.
        if (!tex || tex === normalizedTex(displayMathSource(before))) {
          if (byKey) cancel()
          else close()
          return true
        }
        if (mathBlockValue(tex) === null) {
          writing.error.hidden = false
          return false
        }
        close()
        setMathBlockTex(editor.state, pos, tex, editor.view.dispatch)
        if (byKey) editor.view.focus()
        return true
      }
      const open = () => {
        if (writing || !editor.isEditable) return
        const panel = document.createElement("div")
        panel.className = "amby-math-editor"
        const area = document.createElement("textarea")
        area.className = "amby-math-input"
        area.spellcheck = false
        area.setAttribute("aria-label", i18n.t("editor.math.label"))
        area.setAttribute("autocapitalize", "off")
        area.setAttribute("autocorrect", "off")
        area.placeholder = i18n.t("editor.math.placeholder")
        area.value = displayMathSource(String(current.attrs.value ?? "")).replace(/\r\n?/gu, "\n")
        const fit = () => {
          area.rows = Math.min(12, Math.max(2, area.value.split("\n").length))
        }
        fit()
        const error = document.createElement("p")
        error.className = "amby-math-error"
        error.setAttribute("role", "alert")
        error.textContent = i18n.t("editor.math.cannotWrite")
        error.hidden = true
        const hint = document.createElement("p")
        hint.className = "amby-math-hint"
        hint.textContent = i18n.t("editor.math.hint")
        panel.append(area, error, hint)
        dom.append(panel)
        dom.classList.add("is-writing")
        writing = { panel, area, error }

        area.addEventListener("input", () => {
          fit()
          preview()
        })
        area.addEventListener("keydown", (event) => {
          if (event.key === "Escape") {
            event.preventDefault()
            cancel()
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            apply(true)
          }
        })
        // A click anywhere else, or the window losing the focus, applies what was written.
        area.addEventListener("blur", () => {
          if (writing?.area === area) apply(false)
        })
        // The block has just been drawn, or the editor is still handling the key.
        queueMicrotask(() => {
          if (writing?.area !== area) return
          area.focus()
          area.setSelectionRange(area.value.length, area.value.length)
        })
      }

      dom.addEventListener(MATH_EDIT_EVENT, open)
      dom.addEventListener("click", () => {
        if (!writing) open()
      })
      // While the TeX is open, a press on the formula keeps the cursor in the text area.
      dom.addEventListener("mousedown", (event) => {
        if (writing && event.target !== writing.area) event.preventDefault()
      })
      if (takeOpenRequest(node)) open()

      return {
        dom,
        update(next) {
          if (next.type !== current.type || next.attrs.kind !== "math") return false
          const changed = next.attrs.value !== current.attrs.value
          current = next
          if (changed && !writing) draw()
          return true
        },
        selectNode: () => dom.classList.add("is-selected"),
        deselectNode: () => dom.classList.remove("is-selected"),
        // The text area and the formula are not the note: the editor neither reads keys
        // and clicks meant for them nor redraws the block when they change.
        stopEvent: (event) => writing !== null && event.target instanceof globalThis.Node,
        ignoreMutation: () => true,
        destroy() {
          writing = null
        },
      }
    }
  },
})
