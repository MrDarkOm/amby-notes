import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight"
import { common, createLowlight } from "lowlight"

import i18n from "@/lib/i18n"

// The code block of the note: the same node and the same Markdown as before (a fence and
// its language), drawn with syntax colours, the language as a label and a Copy button.
// The colours are decorations and the bar is outside the document, so nothing of this
// reaches the file.

const lowlight = createLowlight(common)

const COPIED_MS = 1500

export const AmbyCodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ({ node }) => {
      let current = node
      let copiedTimer: ReturnType<typeof setTimeout> | null = null

      const dom = document.createElement("div")
      dom.className = "amby-code-block"
      const bar = document.createElement("div")
      bar.className = "amby-code-block-bar"
      bar.contentEditable = "false"
      const label = document.createElement("span")
      label.className = "amby-code-block-language"
      const copy = document.createElement("button")
      copy.type = "button"
      copy.className = "amby-code-block-copy"
      copy.textContent = i18n.t("editor.code.copy")
      bar.append(label, copy)
      const pre = document.createElement("pre")
      const code = document.createElement("code")
      pre.append(code)
      dom.append(bar, pre)

      const sync = () => {
        const language = typeof current.attrs.language === "string" ? current.attrs.language : ""
        label.textContent = language || i18n.t("editor.code.plain")
        code.className = language ? `language-${language}` : ""
      }
      sync()

      // The cursor stays in the note while the button is used.
      copy.addEventListener("mousedown", (event) => event.preventDefault())
      copy.addEventListener("click", (event) => {
        event.preventDefault()
        const done = (key: string) => {
          copy.textContent = i18n.t(key)
          if (copiedTimer) clearTimeout(copiedTimer)
          copiedTimer = setTimeout(() => {
            copy.textContent = i18n.t("editor.code.copy")
          }, COPIED_MS)
        }
        const text = current.textContent
        if (!navigator.clipboard?.writeText) {
          done("editor.code.copyFailed")
          return
        }
        navigator.clipboard.writeText(text).then(
          () => done("editor.code.copied"),
          () => done("editor.code.copyFailed"),
        )
      })

      return {
        dom,
        contentDOM: code,
        update(next) {
          if (next.type !== current.type) return false
          current = next
          sync()
          return true
        },
        // Whatever changes in the bar (its text, a tooltip taking its title) is not a
        // change of the note: the editor must not draw the block again because of it.
        ignoreMutation(mutation) {
          if (mutation.type === "selection") return false
          return !code.contains(mutation.target)
        },
        stopEvent(event) {
          return event.target instanceof Node && bar.contains(event.target)
        },
        destroy() {
          if (copiedTimer) clearTimeout(copiedTimer)
        },
      }
    }
  },
}).configure({ lowlight, defaultLanguage: null })
