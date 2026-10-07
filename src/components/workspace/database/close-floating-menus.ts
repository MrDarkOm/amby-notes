import { CLOSE_BLOCK_MENUS_EVENT, CLOSE_EDITOR_MENUS_EVENT } from "../tiptap/floating-menu-events"

/** Closes the other floating menus and pickers before one opens: only one is open at a time. */
export function closeFloatingMenus() {
  window.dispatchEvent(new Event(CLOSE_BLOCK_MENUS_EVENT))
  window.dispatchEvent(new Event(CLOSE_EDITOR_MENUS_EVENT))
}
