/**
 * Portable Amby theme format. Themes are data, not executable CSS: only a
 * small, reviewed set of visual tokens can be changed. This makes downloaded
 * theme files safe to inspect, share, import and delete.
 */
const THEME_FORMAT = "amby-theme" as const
const THEME_VERSION = 1 as const

type ThemeMode = "light" | "dark"

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

type ThemeToken = (typeof THEME_TOKENS)[number]

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
  id: "dark" | "light" | "system" | "catppuccin" | "catppuccin-light" | "gruvbox" | "gruvbox-light"
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
    id: "catppuccin",
    name: "Catppuccin",
    mode: "dark",
    builtin: true,
    tokens: {
      // Keep the workspace slightly lighter than the surfaces placed on it.
      // This mirrors the light theme hierarchy while preserving Catppuccin's
      // deep blue-violet contrast.
      "--background": "240 17% 18%",
      "--foreground": "227 68% 88%",
      "--secondary": "240 17% 16%",
      "--secondary-foreground": "227 68% 88%",
      "--muted": "237 16% 17%",
      "--muted-foreground": "232 12% 56%",
      "--accent": "237 16% 24%",
      "--accent-foreground": "227 68% 88%",
      "--destructive": "343 81% 75%",
      "--destructive-foreground": "240 17% 18%",
      "--border": "237 16% 24%",
      "--input": "237 16% 24%",
      "--popover": "240 17% 11%",
      "--popover-foreground": "227 68% 88%",
      "--card": "240 17% 14%",
      "--card-foreground": "227 68% 88%",
      "--workspace-bg": "#292832",
      "--note-surface": "#181825",
      "--note-surface-shadow":
        "0 1px 0 rgba(255, 255, 255, 0.03) inset, 0 8px 24px rgba(17, 17, 27, 0.45)",
      "--editor-fg": "#cdd6f4",
      "--editor-heading": "#f5e0e0",
      "--editor-heading-h2": "#cba6f7",
      "--editor-heading-h3": "#b4befe",
      "--editor-heading-h4": "#89b4fa",
      "--editor-heading-muted": "#a6adc8",
      "--editor-strong": "#f5e0e0",
      "--editor-em": "#bac2de",
      "--editor-del": "#f38ba8",
      "--code-bg": "#181825",
      "--code-fg": "#f5c2e7",
      "--code-border": "#313244",
      "--pre-bg": "#181825",
      "--pre-border": "#45475a",
      "--pre-fg": "#cdd6f4",
      "--blockquote-border-color": "#89b4fa",
      "--blockquote-bg": "rgba(137, 180, 250, 0.1)",
      "--blockquote-fg": "#bac2de",
      "--rule-color": "#45475a",
      "--table-header-bg": "#313244",
      "--table-header-fg": "#cdd6f4",
      "--table-border": "#45475a",
      "--table-cell-border": "#313244",
      "--table-row-even": "#292c3c",
      "--link-color": "#89b4fa",
      "--link-hover-color": "#b4befe",
      "--tag-bg": "rgba(203, 166, 247, 0.16)",
      "--tag-fg": "#cba6f7",
      "--wikilink-bg": "rgba(148, 226, 213, 0.12)",
      "--wikilink-fg": "#94e2d5",
      "--menu-bg": "#181825",
      "--menu-border": "#313244",
      "--menu-item-fg": "#cdd6f4",
      "--menu-item-hover-bg": "#313244",
      "--menu-item-hover-fg": "#f5e0e0",
      "--panel-bg": "#181825",
      "--panel-border": "#313244",
      "--panel-input-bg": "#1e1e2e",
      "--panel-input-border": "#45475a",
      "--panel-row-fg": "#cdd6f4",
      "--panel-row-hover-bg": "#24243a",
      "--panel-row-active-bg": "rgba(203, 166, 247, 0.16)",
      "--scrollbar-thumb": "#45475a",
      "--scrollbar-thumb-hover": "#585b70",
    },
  },
  {
    id: "gruvbox",
    name: "Material Gruvbox",
    mode: "dark",
    builtin: true,
    tokens: {
      // Gruvbox's soft dark base gives the chrome a little lift while the
      // editor, sidebars and dialogs stay on the darker dark0 surfaces.
      "--background": "27 7% 19%",
      "--foreground": "42 43% 81%",
      "--secondary": "27 7% 17%",
      "--secondary-foreground": "42 43% 81%",
      "--muted": "27 8% 22%",
      "--muted-foreground": "34 17% 59%",
      "--accent": "27 9% 28%",
      "--accent-foreground": "44 90% 88%",
      "--destructive": "6 94% 59%",
      "--destructive-foreground": "27 7% 19%",
      "--border": "27 8% 25%",
      "--input": "27 8% 25%",
      "--popover": "27 8% 11%",
      "--popover-foreground": "42 43% 81%",
      "--card": "27 8% 14%",
      "--card-foreground": "42 43% 81%",
      "--workspace-bg": "#32302f",
      "--note-surface": "#1d2021",
      "--note-surface-shadow":
        "0 1px 0 rgba(235, 219, 178, 0.04) inset, 0 8px 24px rgba(29, 32, 33, 0.5)",
      "--editor-fg": "#ebdbb2",
      "--editor-heading": "#fbf1c7",
      "--editor-heading-h2": "#fabd2f",
      "--editor-heading-h3": "#b8bb26",
      "--editor-heading-h4": "#83a598",
      "--editor-heading-muted": "#a89984",
      "--editor-strong": "#fbf1c7",
      "--editor-em": "#d5c4a1",
      "--editor-del": "#fb4934",
      "--code-bg": "#1d2021",
      "--code-fg": "#fe8019",
      "--code-border": "#504945",
      "--pre-bg": "#1d2021",
      "--pre-border": "#3c3836",
      "--pre-fg": "#ebdbb2",
      "--blockquote-border-color": "#83a598",
      "--blockquote-bg": "rgba(131, 165, 152, 0.12)",
      "--blockquote-fg": "#d5c4a1",
      "--rule-color": "#504945",
      "--table-header-bg": "#3c3836",
      "--table-header-fg": "#fbf1c7",
      "--table-border": "#504945",
      "--table-cell-border": "#3c3836",
      "--table-row-even": "#32302f",
      "--link-color": "#83a598",
      "--link-hover-color": "#8ec07c",
      "--tag-bg": "rgba(250, 189, 47, 0.16)",
      "--tag-fg": "#fabd2f",
      "--wikilink-bg": "rgba(142, 192, 124, 0.13)",
      "--wikilink-fg": "#8ec07c",
      "--menu-bg": "#1d2021",
      "--menu-border": "#504945",
      "--menu-item-fg": "#ebdbb2",
      "--menu-item-hover-bg": "#3c3836",
      "--menu-item-hover-fg": "#fbf1c7",
      "--panel-bg": "#1d2021",
      "--panel-border": "#3c3836",
      "--panel-input-bg": "#282828",
      "--panel-input-border": "#504945",
      "--panel-row-fg": "#ebdbb2",
      "--panel-row-hover-bg": "#32302f",
      "--panel-row-active-bg": "rgba(250, 189, 47, 0.16)",
      "--scrollbar-thumb": "#665c54",
      "--scrollbar-thumb-hover": "#7c6f64",
    },
  },
  {
    id: "catppuccin-light",
    name: "Catppuccin",
    mode: "light",
    builtin: true,
    tokens: {
      "--background": "250 35% 95%",
      "--foreground": "234 16% 30%",
      "--secondary": "250 25% 92%",
      "--secondary-foreground": "234 16% 30%",
      "--muted": "250 24% 91%",
      "--muted-foreground": "233 13% 48%",
      "--accent": "250 28% 87%",
      "--accent-foreground": "234 16% 30%",
      "--destructive": "347 87% 47%",
      "--destructive-foreground": "0 0% 100%",
      "--border": "250 18% 81%",
      "--input": "250 18% 81%",
      "--popover": "250 40% 99%",
      "--popover-foreground": "234 16% 30%",
      "--card": "250 40% 99%",
      "--card-foreground": "234 16% 30%",
      "--workspace-bg": "#eeebf8",
      "--note-surface": "#fffaff",
      "--note-surface-shadow":
        "0 1px 2px rgba(76, 79, 105, 0.08), 0 8px 24px rgba(76, 79, 105, 0.06)",
      "--editor-fg": "#4c4f69",
      "--editor-heading": "#1e1e2e",
      "--editor-heading-h2": "#8839ef",
      "--editor-heading-h3": "#1e66f5",
      "--editor-heading-h4": "#179299",
      "--editor-heading-muted": "#6c6f85",
      "--editor-strong": "#1e1e2e",
      "--editor-em": "#6c6f85",
      "--editor-del": "#d20f39",
      "--code-bg": "#eeeafa",
      "--code-fg": "#8839ef",
      "--code-border": "#d6d0e8",
      "--pre-bg": "#faf8ff",
      "--pre-border": "#e1dced",
      "--pre-fg": "#4c4f69",
      "--blockquote-border-color": "#1e66f5",
      "--blockquote-bg": "rgba(30, 102, 245, 0.07)",
      "--blockquote-fg": "#5c5f77",
      "--rule-color": "#e1dced",
      "--table-header-bg": "#eeeafa",
      "--table-header-fg": "#4c4f69",
      "--table-border": "#d6d0e8",
      "--table-cell-border": "#e1dced",
      "--table-row-even": "#faf8ff",
      "--link-color": "#1e66f5",
      "--link-hover-color": "#7287fd",
      "--tag-bg": "rgba(136, 57, 239, 0.1)",
      "--tag-fg": "#8839ef",
      "--wikilink-bg": "rgba(23, 146, 153, 0.1)",
      "--wikilink-fg": "#179299",
      "--menu-bg": "#fffaff",
      "--menu-border": "#d6d0e8",
      "--menu-item-fg": "#4c4f69",
      "--menu-item-hover-bg": "#eeebf8",
      "--menu-item-hover-fg": "#1e1e2e",
      "--panel-bg": "#fffaff",
      "--panel-border": "#d6d0e8",
      "--panel-input-bg": "#f5f1fb",
      "--panel-input-border": "#d6d0e8",
      "--panel-row-fg": "#4c4f69",
      "--panel-row-hover-bg": "#eeebf8",
      "--panel-row-active-bg": "rgba(136, 57, 239, 0.1)",
      "--scrollbar-thumb": "#c8c2d8",
      "--scrollbar-thumb-hover": "#aca5c0",
    },
  },
  {
    id: "gruvbox-light",
    name: "Material Gruvbox",
    mode: "light",
    builtin: true,
    tokens: {
      "--background": "40 33% 94%",
      "--foreground": "28 14% 24%",
      "--secondary": "40 32% 90%",
      "--secondary-foreground": "28 14% 24%",
      "--muted": "39 26% 89%",
      "--muted-foreground": "30 9% 43%",
      "--accent": "38 30% 85%",
      "--accent-foreground": "28 14% 24%",
      "--destructive": "6 63% 45%",
      "--destructive-foreground": "0 0% 100%",
      "--border": "37 24% 76%",
      "--input": "37 24% 76%",
      "--popover": "42 42% 98%",
      "--popover-foreground": "28 14% 24%",
      "--card": "42 42% 98%",
      "--card-foreground": "28 14% 24%",
      "--workspace-bg": "#f3eee2",
      "--note-surface": "#fffdf7",
      "--note-surface-shadow":
        "0 1px 2px rgba(60, 56, 54, 0.08), 0 8px 24px rgba(60, 56, 54, 0.06)",
      "--editor-fg": "#3c3836",
      "--editor-heading": "#282828",
      "--editor-heading-h2": "#b57614",
      "--editor-heading-h3": "#79740e",
      "--editor-heading-h4": "#427b58",
      "--editor-heading-muted": "#7c6f64",
      "--editor-strong": "#282828",
      "--editor-em": "#7c6f64",
      "--editor-del": "#9d0006",
      "--code-bg": "#f2e5bc",
      "--code-fg": "#af3a03",
      "--code-border": "#d5c4a1",
      "--pre-bg": "#f9f5d7",
      "--pre-border": "#ebdbb2",
      "--pre-fg": "#3c3836",
      "--blockquote-border-color": "#076678",
      "--blockquote-bg": "rgba(7, 102, 120, 0.07)",
      "--blockquote-fg": "#665c54",
      "--rule-color": "#d5c4a1",
      "--table-header-bg": "#ebdbb2",
      "--table-header-fg": "#3c3836",
      "--table-border": "#d5c4a1",
      "--table-cell-border": "#ebdbb2",
      "--table-row-even": "#f9f5d7",
      "--link-color": "#076678",
      "--link-hover-color": "#427b58",
      "--tag-bg": "rgba(181, 118, 20, 0.12)",
      "--tag-fg": "#9d6500",
      "--wikilink-bg": "rgba(66, 123, 88, 0.1)",
      "--wikilink-fg": "#427b58",
      "--menu-bg": "#fffdf7",
      "--menu-border": "#d5c4a1",
      "--menu-item-fg": "#3c3836",
      "--menu-item-hover-bg": "#f2e5bc",
      "--menu-item-hover-fg": "#282828",
      "--panel-bg": "#fffdf7",
      "--panel-border": "#d5c4a1",
      "--panel-input-bg": "#f9f5d7",
      "--panel-input-border": "#d5c4a1",
      "--panel-row-fg": "#3c3836",
      "--panel-row-hover-bg": "#f2e5bc",
      "--panel-row-active-bg": "rgba(181, 118, 20, 0.12)",
      "--scrollbar-thumb": "#d5c4a1",
      "--scrollbar-thumb-hover": "#bdae93",
    },
  },
]

export type ThemeModePreference = "light" | "dark" | "system"

export interface BuiltinThemeFamily {
  id: "amby" | "catppuccin" | "gruvbox"
  variants: Partial<Record<ThemeModePreference, BuiltinTheme["id"]>>
}

/** Built-in palettes grouped by family for the two-level theme picker. */
export const BUILTIN_THEME_FAMILIES: BuiltinThemeFamily[] = [
  { id: "amby", variants: { light: "light", dark: "dark", system: "system" } },
  { id: "catppuccin", variants: { light: "catppuccin-light", dark: "catppuccin" } },
  { id: "gruvbox", variants: { light: "gruvbox-light", dark: "gruvbox" } },
]

export function builtinThemeFamilyForId(id: string): BuiltinThemeFamily | undefined {
  return BUILTIN_THEME_FAMILIES.find((family) =>
    Object.values(family.variants).includes(id as BuiltinTheme["id"]),
  )
}

/** IDs used by the previous built-in themes, kept as one-way migrations. */
const LEGACY_THEME_IDS: Record<string, BuiltinTheme["id"]> = {
  midnight: "catppuccin",
  paper: "gruvbox",
}

export function migrateThemeId(id: string): string {
  return LEGACY_THEME_IDS[id] ?? id
}

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
  const resolvedId = migrateThemeId(id)
  return (
    BUILTIN_THEMES.find((theme) => theme.id === resolvedId) ??
    installed.find((theme) => theme.id === resolvedId) ??
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
    ...BUILTIN_THEME_FAMILIES.map((family) => family.id),
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
