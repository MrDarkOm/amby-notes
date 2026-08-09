/** All editable application color palettes live here, outside components. */

export const ACCENT_HEX = {
  violet: "#8b5cf6",
  sky: "#0ea5e9",
  teal: "#14b8a6",
  emerald: "#10b981",
  amber: "#f59e0b",
  rose: "#f43f5e",
} as const

export const EDITOR_TEXT_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#a855f7",
  "#f472b6",
  "#e5e7eb",
] as const

export const EDITOR_BACKGROUND_COLORS = [
  "#7f1d1d",
  "#7c2d12",
  "#713f12",
  "#14532d",
  "#164e63",
  "#1e3a8a",
  "#4c1d95",
  "#831843",
  "#3f3f46",
] as const

export const CALLOUT_SWATCHES: ReadonlyArray<{ id: string; color?: string }> = [
  { id: "teal", color: "rgba(20, 184, 166, 0.45)" },
  { id: "orange", color: "rgba(245, 158, 11, 0.55)" },
  { id: "blue", color: "rgba(14, 165, 233, 0.55)" },
  { id: "green", color: "rgba(34, 197, 94, 0.55)" },
  { id: "red", color: "rgba(239, 68, 68, 0.55)" },
  { id: "purple", color: "rgba(168, 85, 247, 0.55)" },
  { id: "zinc", color: "rgba(113, 113, 122, 0.55)" },
  { id: "none" },
]

export const BLOCK_TEXT_COLORS: ReadonlyArray<{ id: string; color: string | null }> = [
  { id: "red", color: "#ef4444" },
  { id: "orange", color: "#f59e0b" },
  { id: "green", color: "#22c55e" },
  { id: "blue", color: "#3b82f6" },
  { id: "purple", color: "#a855f7" },
  { id: "pink", color: "#ec4899" },
  { id: "zinc", color: "#a1a1aa" },
  { id: "clear", color: null },
]

export const THEME_PREVIEW_FALLBACK = {
  dark: { background: "#09090b", surface: "#18181b", border: "#3f3f46" },
  light: { background: "#f8fafc", surface: "#ffffff", border: "#d4d4d8" },
} as const

export const CANVAS_UI_COLORS = {
  fallbackAccent: "#52525b",
  backgroundDots: "#3f3f46",
  minimapMask: "rgba(0,0,0,0.6)",
  minimapNode: "#52525b",
} as const

/** Obsidian Canvas numeric colors; kept here so every editable color is centralized. */
export const OBSIDIAN_CANVAS_PRESET_COLORS: Record<string, string> = {
  "1": "#e93147",
  "2": "#ec7500",
  "3": "#e0ac00",
  "4": "#08b94e",
  "5": "#00bfbc",
  "6": "#7852ee",
}
