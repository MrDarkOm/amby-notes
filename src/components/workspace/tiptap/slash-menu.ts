import { Extension, type Editor, type Range } from "@tiptap/core"
import Suggestion, { exitSuggestion, SuggestionPluginKey } from "@tiptap/suggestion"

export interface SlashTriggerState {
  open: boolean
  range: Range | null
  query: string
  rect: DOMRect | null
  /** Bumped every time state changes so React subscribers can re-render. */
  version: number
}

export const SLASH_TRIGGER_EVENT = "amby:slash-trigger"
export const SLASH_MENU_KEY_EVENT = "amby:slash-menu-key"

export interface SlashMenuKey {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

function notify() {
  if (typeof window === "undefined") return
  window.dispatchEvent(new Event(SLASH_TRIGGER_EVENT))
}

function notifyKey(event: KeyboardEvent) {
  if (typeof window === "undefined") return
  const detail: SlashMenuKey = {
    key: event.key,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
  }
  window.dispatchEvent(new CustomEvent<SlashMenuKey>(SLASH_MENU_KEY_EVENT, { detail }))
}

function getSlashStorage(editor: Editor): SlashTriggerState {
  return (editor.storage as unknown as { slashMenu: SlashTriggerState }).slashMenu
}

export const SlashMenu = Extension.create({
  name: "slashMenu",

  addStorage(): SlashTriggerState {
    return { open: false, range: null, query: "", rect: null, version: 0 }
  },

  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      Suggestion({
        editor,
        char: "/",
        startOfLine: false,
        items: ({ query }) => [{ query }],
        command: () => {
          // Selection handled by the React panel — nothing to do here.
        },
        render: () => {
          return {
            onStart: (props) => {
              const s = getSlashStorage(editor)
              s.open = true
              s.range = props.range
              s.query = props.query
              s.rect = (props.clientRect?.() as DOMRect | null) ?? null
              s.version++
              notify()
            },
            onUpdate: (props) => {
              const s = getSlashStorage(editor)
              s.open = true
              s.range = props.range
              s.query = props.query
              s.rect = (props.clientRect?.() as DOMRect | null) ?? null
              s.version++
              notify()
            },
            onKeyDown: ({ event }) => {
              if (event.key === "Escape") {
                dismissSlashMenu(editor)
                return true
              }
              // The React panel normally owns focus. If ProseMirror briefly
              // reclaims it while opening, keep the next key out of the note
              // and forward it to the panel as a fallback.
              notifyKey(event)
              return true
            },
            onExit: () => {
              closeSlashMenu(editor)
            },
          }
        },
      }),
    ]
  },
})

export function closeSlashMenu(editor: Editor) {
  const s = getSlashStorage(editor)
  if (!s) return
  s.open = false
  s.range = null
  s.query = ""
  s.rect = null
  s.version++
  notify()
}

/**
 * Close the React surface and dismiss the Suggestion plugin itself. Keeping
 * the plugin dismissed is important: otherwise the next transaction near the
 * same slash immediately opens the menu again and captures Backspace/text.
 */
export function dismissSlashMenu(editor: Editor) {
  if (editor.isDestroyed) return
  const state = getSlashStorage(editor)
  const suggestionState = SuggestionPluginKey.getState(editor.state) as
    { active?: boolean } | undefined
  if (suggestionState?.active) exitSuggestion(editor.view)
  // exitSuggestion normally invokes onExit synchronously. Keep this fallback
  // for a closed/inactive plugin so the React surface never remains mounted.
  if (state?.open) closeSlashMenu(editor)
}

export function readSlashStorage(editor: Editor): SlashTriggerState | null {
  const s = (editor.storage as unknown as { slashMenu?: SlashTriggerState }).slashMenu
  return s ?? null
}
