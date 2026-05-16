import { Extension, type Editor, type Range } from "@tiptap/core"
import Suggestion, { type SuggestionProps } from "@tiptap/suggestion"

import { INLINE_INSERT_ITEMS, type BlockInsertItem } from "./block-insert-items"

class SlashPopup {
  private root: HTMLElement
  private items: BlockInsertItem[] = []
  private selected = 0
  private props: SuggestionProps<BlockInsertItem> | null = null

  constructor() {
    this.root = document.createElement("div")
    this.root.className = "amby-slash-menu"
    this.root.style.position = "fixed"
    this.root.style.zIndex = "60"
  }

  update(props: SuggestionProps<BlockInsertItem>) {
    this.props = props
    this.items = props.items
    this.selected = 0
    const rect = props.clientRect?.()
    if (!this.items.length || !rect) {
      this.hide()
      return
    }
    if (!this.root.isConnected) document.body.appendChild(this.root)
    this.root.style.left = `${rect.left}px`
    this.root.style.top = `${rect.bottom + 6}px`
    this.render()
  }

  private render() {
    this.root.replaceChildren()
    this.items.forEach((item, index) => {
      const button = document.createElement("button")
      button.type = "button"
      button.className = "amby-slash-item" + (index === this.selected ? " is-active" : "")
      const title = document.createElement("span")
      title.className = "amby-slash-title"
      title.textContent = item.title
      const hint = document.createElement("span")
      hint.className = "amby-slash-hint"
      hint.textContent = item.hint
      button.append(title, hint)
      button.addEventListener("mousedown", event => {
        event.preventDefault()
        this.choose(index)
      })
      this.root.appendChild(button)
    })
  }

  private choose(index: number) {
    const item = this.items[index]
    const props = this.props
    if (item && props) runSlashItem(props.editor, props.range, item)
  }

  onKeyDown(event: KeyboardEvent): boolean {
    if (!this.items.length) return false
    if (event.key === "ArrowDown") {
      this.selected = (this.selected + 1) % this.items.length
      this.render()
      return true
    }
    if (event.key === "ArrowUp") {
      this.selected = (this.selected - 1 + this.items.length) % this.items.length
      this.render()
      return true
    }
    if (event.key === "Enter") {
      this.choose(this.selected)
      return true
    }
    if (event.key === "Escape") {
      this.hide()
      return true
    }
    return false
  }

  hide() {
    if (this.root.isConnected) this.root.remove()
  }
}

function runSlashItem(editor: Editor, range: Range, item: BlockInsertItem) {
  editor.chain().focus().deleteRange(range).run()
  item.inline(editor)
}

export const SlashMenu = Extension.create({
  name: "slashMenu",

  addProseMirrorPlugins() {
    return [
      Suggestion<BlockInsertItem>({
        editor: this.editor,
        char: "/",
        startOfLine: false,
        items: ({ query }) =>
          INLINE_INSERT_ITEMS.filter(item =>
            item.title.toLowerCase().includes(query.toLowerCase()),
          ),
        command: ({ editor, range, props }) => runSlashItem(editor, range, props),
        render: () => {
          let popup: SlashPopup | null = null
          return {
            onStart: props => {
              popup = new SlashPopup()
              popup.update(props)
            },
            onUpdate: props => popup?.update(props),
            onKeyDown: ({ event }) => popup?.onKeyDown(event) ?? false,
            onExit: () => {
              popup?.hide()
              popup = null
            },
          }
        },
      }),
    ]
  },
})
