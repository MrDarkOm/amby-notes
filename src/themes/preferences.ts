/** Appearance preference values consumed by runtime components. */
export const EDITOR_FONT_SIZE = {
  sm: "1.02rem",
  md: "1.02rem",
  lg: "1.02rem",
} as const

export const APP_FONT_SIZE = {
  sm: "14px",
  md: "16px",
  lg: "18px",
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
