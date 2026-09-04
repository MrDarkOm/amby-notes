export const SHORTCUT_DEFINITIONS = [
  {
    id: "quickOpen",
    labelKey: "settings.shortcuts.quickOpen",
    defaultBinding: "Mod+P",
  },
  {
    id: "search",
    labelKey: "settings.shortcuts.search",
    defaultBinding: "Mod+Shift+F",
  },
  {
    id: "newNote",
    labelKey: "settings.shortcuts.newNote",
    defaultBinding: "Mod+N",
  },
  {
    id: "toggleLeftSidebar",
    labelKey: "settings.shortcuts.toggleLeftSidebar",
    defaultBinding: "Mod+B",
  },
  {
    id: "toggleRightSidebar",
    labelKey: "settings.shortcuts.toggleRightSidebar",
    defaultBinding: "Mod+Shift+B",
  },
  {
    id: "settings",
    labelKey: "settings.shortcuts.settings",
    defaultBinding: "Mod+Comma",
  },
  {
    id: "back",
    labelKey: "settings.shortcuts.back",
    defaultBinding: "Mod+BracketLeft",
  },
  {
    id: "forward",
    labelKey: "settings.shortcuts.forward",
    defaultBinding: "Mod+BracketRight",
  },
] as const

export type ShortcutActionId = (typeof SHORTCUT_DEFINITIONS)[number]["id"]
export type ShortcutBindings = Record<ShortcutActionId, string>

export const DEFAULT_SHORTCUTS = Object.fromEntries(
  SHORTCUT_DEFINITIONS.map(({ id, defaultBinding }) => [id, defaultBinding]),
) as ShortcutBindings

interface KeyboardEventLike {
  key: string
  code: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

const MODIFIER_KEYS = new Set(["Alt", "AltGraph", "Control", "Meta", "Shift"])
const NAMED_KEYS: Record<string, string> = {
  " ": "Space",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  Escape: "Escape",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Insert: "Insert",
}

const PUNCTUATION_CODES: Record<string, string> = {
  Backquote: "Backquote",
  Backslash: "Backslash",
  BracketLeft: "BracketLeft",
  BracketRight: "BracketRight",
  Comma: "Comma",
  Equal: "Equal",
  Minus: "Minus",
  Period: "Period",
  Quote: "Quote",
  Semicolon: "Semicolon",
  Slash: "Slash",
}

function eventKey(event: KeyboardEventLike): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null
  if (NAMED_KEYS[event.key]) return NAMED_KEYS[event.key]
  if (/^F(?:[1-9]|1[0-2])$/u.test(event.key)) return event.key
  if (PUNCTUATION_CODES[event.code]) return PUNCTUATION_CODES[event.code]
  return event.key.length === 1 ? event.key.toLocaleUpperCase() : event.key
}

export type ShortcutCaptureResult =
  | { status: "captured"; binding: string }
  | { status: "modifier-only" }
  | { status: "needs-modifier" }

export function shortcutFromEvent(
  event: KeyboardEventLike,
  mac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform),
): ShortcutCaptureResult {
  const key = eventKey(event)
  if (!key) return { status: "modifier-only" }

  const parts: string[] = []
  if (mac ? event.metaKey : event.ctrlKey) parts.push("Mod")
  if (event.ctrlKey && mac) parts.push("Ctrl")
  if (event.metaKey && !mac) parts.push("Meta")
  if (event.altKey) parts.push("Alt")
  if (event.shiftKey) parts.push("Shift")

  const isFunctionKey = /^F(?:[1-9]|1[0-2])$/u.test(key)
  if (parts.length === 0 && !isFunctionKey) return { status: "needs-modifier" }
  return { status: "captured", binding: [...parts, key].join("+") }
}

export function matchesShortcut(
  event: KeyboardEventLike,
  binding: string,
  mac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform),
): boolean {
  const parts = binding.split("+")
  const key = parts[parts.length - 1]
  if (!key || eventKey(event) !== key) return false

  const wantsMod = parts.includes("Mod")
  const wantsCtrl = parts.includes("Ctrl") || (wantsMod && !mac)
  const wantsMeta = parts.includes("Meta") || (wantsMod && mac)
  return (
    event.ctrlKey === wantsCtrl &&
    event.metaKey === wantsMeta &&
    event.altKey === parts.includes("Alt") &&
    event.shiftKey === parts.includes("Shift")
  )
}

export function formatShortcut(
  binding: string,
  mac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform),
): string {
  const labels: Record<string, string> = {
    Mod: mac ? "⌘" : "Ctrl",
    Meta: mac ? "⌘" : "Meta",
    Ctrl: "Ctrl",
    Alt: mac ? "⌥" : "Alt",
    Shift: mac ? "⇧" : "Shift",
    BracketLeft: "[",
    BracketRight: "]",
    Backquote: "`",
    Backslash: "\\",
    Comma: ",",
    Equal: "=",
    Minus: "−",
    Period: ".",
    Quote: "'",
    Semicolon: ";",
    Slash: "/",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
  }
  return binding
    .split("+")
    .map((part) => labels[part] ?? part)
    .join(" + ")
}

export function normalizeShortcutBindings(raw: unknown): ShortcutBindings {
  const stored = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  return Object.fromEntries(
    SHORTCUT_DEFINITIONS.map(({ id, defaultBinding }) => [
      id,
      typeof stored[id] === "string" && stored[id] ? stored[id] : defaultBinding,
    ]),
  ) as ShortcutBindings
}
