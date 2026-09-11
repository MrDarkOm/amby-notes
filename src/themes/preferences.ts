/** Appearance preference values consumed by runtime components. */
export const EDITOR_FONT_SIZE = {
  sm: "calc(1.02rem * var(--app-font-scale, 1))",
  md: "calc(1.02rem * var(--app-font-scale, 1))",
  lg: "calc(1.02rem * var(--app-font-scale, 1))",
} as const

export const APP_FONT_SCALE = {
  sm: "0.875",
  md: "1",
  lg: "1.125",
} as const

export const APP_FONT_FAMILY = {
  system: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  sans: 'Inter, ui-sans-serif, "Segoe UI", sans-serif',
  serif: 'Iowan Old Style, "Palatino Linotype", Georgia, serif',
  mono: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
} as const

export const EDITOR_CONTENT_WIDTH = {
  normal: "48rem",
  wide: "64rem",
  full: "none",
} as const

export const CODE_EDITOR_THEME = {
  selectionBackground: "hsl(var(--primary) / 0.22)",
} as const
