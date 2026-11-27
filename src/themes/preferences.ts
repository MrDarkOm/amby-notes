/** Appearance preference values consumed by runtime components. */
export const EDITOR_FONT_SIZE = "calc(1.02rem * var(--app-font-scale, 1))"

/** The interface font size, in percent of the default. */
export const FONT_SIZE = { min: 80, max: 130, default: 100 } as const

/** The percent each of the earlier three sizes stood for. */
export const FONT_SIZE_OF_SCALE = { sm: 88, md: 100, lg: 113 } as const

/** The earlier three-size value nearest to a percent, kept for older builds reading settings. */
export function fontScaleOf(size: number): keyof typeof FONT_SIZE_OF_SCALE {
  return size < 94 ? "sm" : size > 106 ? "lg" : "md"
}

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
