/**
 * Portable Amby theme format. Themes are data, not executable CSS: only a
 * small, reviewed set of visual tokens can be changed. This makes downloaded
 * theme files safe to inspect, share, import and delete.
 */
export const THEME_FORMAT = "amby-theme" as const
export const THEME_VERSION = 1 as const

export type ThemeMode = "light" | "dark"

export const THEME_TOKENS = [
  "--background",
  "--foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--destructive-foreground",
  "--border",
  "--input",
  "--popover",
  "--popover-foreground",
  "--card",
  "--card-foreground",
  "--workspace-bg",
  "--note-surface",
  "--note-surface-shadow",
  "--editor-fg",
  "--editor-heading",
  "--editor-heading-h2",
  "--editor-heading-h3",
  "--editor-heading-h4",
  "--editor-heading-muted",
  "--editor-strong",
  "--editor-em",
  "--editor-del",
  "--code-bg",
  "--code-fg",
  "--code-border",
  "--pre-bg",
  "--pre-border",
  "--pre-fg",
  "--blockquote-border-color",
  "--blockquote-bg",
  "--blockquote-fg",
  "--rule-color",
  "--table-header-bg",
  "--table-header-fg",
  "--table-border",
  "--table-cell-border",
  "--table-row-even",
  "--link-color",
  "--link-hover-color",
  "--tag-bg",
  "--tag-fg",
  "--wikilink-bg",
  "--wikilink-fg",
  "--menu-bg",
  "--menu-border",
  "--menu-item-fg",
  "--menu-item-hover-bg",
  "--menu-item-hover-fg",
  "--panel-bg",
  "--panel-border",
  "--panel-input-bg",
  "--panel-input-border",
  "--panel-row-fg",
  "--panel-row-hover-bg",
  "--panel-row-active-bg",
  "--scrollbar-thumb",
  "--scrollbar-thumb-hover",
] as const

export type ThemeToken = (typeof THEME_TOKENS)[number]

export interface ThemeDefinition {
  format: typeof THEME_FORMAT
  version: typeof THEME_VERSION
  id: string
  name: string
  author?: string
  description?: string
  mode: ThemeMode
  tokens: Partial<Record<ThemeToken, string>>
}

export interface BuiltinTheme {
  id: "dark" | "light" | "system" | "midnight" | "paper"
  name: string
  mode: ThemeMode | "system"
  builtin: true
  tokens: Partial<Record<ThemeToken, string>>
}

export const BUILTIN_THEMES: BuiltinTheme[] = [
  { id: "dark", name: "Dark", mode: "dark", builtin: true, tokens: {} },
  { id: "light", name: "Light", mode: "light", builtin: true, tokens: {} },
  { id: "system", name: "System", mode: "system", builtin: true, tokens: {} },
  {
    id: "midnight",
    name: "Midnight",
    mode: "dark",
    builtin: true,
    tokens: {
      "--background": "225 27% 7%",
      "--foreground": "219 38% 94%",
      "--secondary": "224 20% 14%",
      "--secondary-foreground": "219 38% 94%",
      "--muted": "224 20% 14%",
      "--muted-foreground": "218 18% 66%",
      "--accent": "223 19% 17%",
      "--accent-foreground": "219 38% 94%",
      "--border": "224 19% 18%",
      "--input": "224 19% 18%",
      "--popover": "225 27% 8%",
      "--popover-foreground": "219 38% 94%",
      "--card": "224 24% 10%",
      "--card-foreground": "219 38% 94%",
      "--workspace-bg": "#0c1020",
      "--note-surface": "#12182a",
      "--editor-fg": "#e5eaf5",
      "--editor-heading": "#f7f9ff",
      "--editor-em": "#b2bdd4",
      "--code-bg": "#192238",
      "--code-fg": "#a5b4fc",
      "--pre-bg": "#0f1525",
      "--pre-border": "#26314c",
      "--link-color": "#93c5fd",
      "--link-hover-color": "#bfdbfe",
      "--menu-bg": "#12182a",
      "--menu-border": "#26314c",
      "--panel-bg": "#12182a",
      "--panel-border": "#26314c",
      "--scrollbar-thumb": "#34415f",
      "--scrollbar-thumb-hover": "#4b5c82",
    },
  },
  {
    id: "paper",
    name: "Paper",
    mode: "light",
    builtin: true,
    tokens: {
      "--background": "38 38% 96%",
      "--foreground": "26 22% 15%",
      "--secondary": "36 30% 91%",
      "--secondary-foreground": "26 22% 15%",
      "--muted": "36 25% 91%",
      "--muted-foreground": "28 13% 42%",
      "--accent": "35 29% 89%",
      "--accent-foreground": "26 22% 15%",
      "--border": "31 22% 83%",
      "--input": "31 22% 83%",
      "--popover": "42 42% 98%",
      "--popover-foreground": "26 22% 15%",
      "--card": "42 42% 98%",
      "--card-foreground": "26 22% 15%",
      "--workspace-bg": "#eee8dd",
      "--note-surface": "#fffdf7",
      "--editor-fg": "#2f2922",
      "--editor-heading": "#211b15",
      "--editor-em": "#665d53",
      "--code-bg": "#f4efe5",
      "--code-fg": "#9a3412",
      "--pre-bg": "#f8f4eb",
      "--pre-border": "#dfd5c4",
      "--link-color": "#9a3412",
      "--link-hover-color": "#7c2d12",
      "--menu-bg": "#fffdf7",
      "--menu-border": "#dfd5c4",
      "--panel-bg": "#fffdf7",
      "--panel-border": "#dfd5c4",
      "--scrollbar-thumb": "#cbbda9",
      "--scrollbar-thumb-hover": "#a9967e",
    },
  },
]

const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/u
const forbiddenCss = /(?:url\s*\(|@import|expression\s*\(|javascript:|[;{}])/iu

export function isThemeId(value: unknown): value is string {
  return typeof value === "string" && idPattern.test(value)
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : undefined
}

/** Parse untrusted JSON from a theme file. Unknown tokens are dropped. */
export function parseThemeDefinition(raw: unknown): ThemeDefinition | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const input = raw as Record<string, unknown>
  const id = typeof input.id === "string" ? input.id.trim().toLowerCase() : ""
  const name = text(input.name, 80)
  if (
    input.format !== THEME_FORMAT ||
    input.version !== THEME_VERSION ||
    !isThemeId(id) ||
    !name ||
    (input.mode !== "light" && input.mode !== "dark") ||
    !input.tokens ||
    typeof input.tokens !== "object" ||
    Array.isArray(input.tokens)
  ) {
    return null
  }
  const tokens: Partial<Record<ThemeToken, string>> = {}
  for (const token of THEME_TOKENS) {
    const value = (input.tokens as Record<string, unknown>)[token]
    const normalized = typeof value === "string" ? value.trim() : ""
    if (normalized && normalized.length <= 240 && !forbiddenCss.test(normalized)) {
      tokens[token] = normalized
    }
  }
  if (Object.keys(tokens).length === 0) return null
  return {
    format: THEME_FORMAT,
    version: THEME_VERSION,
    id,
    name,
    author: text(input.author, 80),
    description: text(input.description, 280),
    mode: input.mode,
    tokens,
  }
}

export function themeById(
  id: string,
  installed: ThemeDefinition[],
): BuiltinTheme | ThemeDefinition {
  return (
    BUILTIN_THEMES.find((theme) => theme.id === id) ??
    installed.find((theme) => theme.id === id) ??
    BUILTIN_THEMES[0]
  )
}

/** Never overwrite a built-in or an already imported theme during import. */
export function withUniqueThemeId(
  theme: ThemeDefinition,
  installed: ThemeDefinition[],
): ThemeDefinition {
  const unavailable = new Set([
    ...BUILTIN_THEMES.map((item) => item.id),
    ...installed.map((item) => item.id),
  ])
  if (!unavailable.has(theme.id)) return theme
  for (let number = 2; number < 10_000; number += 1) {
    const suffix = `-${number}`
    const id = `${theme.id.slice(0, 64 - suffix.length)}${suffix}`
    if (!unavailable.has(id)) return { ...theme, id }
  }
  return { ...theme, id: `theme-${crypto.randomUUID().slice(0, 8)}` }
}

export * from "./palettes"
export * from "./preferences"
