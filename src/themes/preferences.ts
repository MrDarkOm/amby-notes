/** Appearance preference values consumed by runtime components. */
export const EDITOR_FONT_SIZE = {
  sm: "0.92rem",
  md: "1.02rem",
  lg: "1.16rem",
} as const

export const EDITOR_CONTENT_WIDTH = {
  normal: "48rem",
  wide: "64rem",
  full: "none",
} as const

export const CODE_EDITOR_THEME = {
  selectionBackground: "hsl(var(--primary) / 0.22)",
} as const
