/**
 * Floating editor surfaces are rendered through independent portals. These
 * events keep them mutually exclusive without coupling their component trees.
 */
export const CLOSE_BLOCK_MENUS_EVENT = "amby:close-block-menus"
export const CLOSE_EDITOR_MENUS_EVENT = "amby:close-editor-menus"
