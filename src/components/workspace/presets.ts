import {
  DEFAULT_BUTTONS,
  findButtonDef,
  type ActivityButton,
  type PanelId,
  type Side,
} from "./panel-registry"
import { ALL_MODULE_IDS, contributedDefIds } from "./modules"

/**
 * A preset is a declarative description of which modules are active and how the
 * UI is laid out. Switching presets is a hot-swap (see use-presets).
 */
export interface Preset {
  id: string
  label: string
  /** Ships with the app. */
  builtin?: boolean
  /** Cannot be edited or removed (the Simple fallback). */
  locked?: boolean
  activeModules: string[]
  layout: ActivityButton[]
  activeBySide: Record<Side, PanelId | null>
}

/**
 * Simple: hard-wired, zero-overhead, the emergency fallback. Pure Markdown —
 * just the file tree and search. Cannot be edited or removed, so a broken or
 * foreign preset always has a safe place to fall back to.
 */
export const SIMPLE_PRESET: Preset = {
  id: "simple",
  label: "Simple",
  builtin: true,
  locked: true,
  activeModules: ["files", "search"],
  layout: [
    { defId: "files", side: "left", order: 0 },
    { defId: "search", side: "left", order: 1 },
  ],
  activeBySide: { left: "files", right: null },
}

/** Standard: the balanced default (tree, tags, favorites, properties, links, graph). */
export const STANDARD_PRESET: Preset = {
  id: "standard",
  label: "Standard",
  builtin: true,
  activeModules: ALL_MODULE_IDS,
  layout: DEFAULT_BUTTONS,
  activeBySide: { left: "files", right: "info" },
}

export const BUILTIN_PRESETS: Preset[] = [SIMPLE_PRESET, STANDARD_PRESET]

export const DEFAULT_PRESET_ID = STANDARD_PRESET.id

/** Resolve a preset id, falling back to Standard for unknown ids. */
export function getPreset(id: string | null | undefined): Preset {
  return BUILTIN_PRESETS.find(p => p.id === id) ?? STANDARD_PRESET
}

/**
 * Validate a preset parsed from JSON (used by import in Phase 3). Drops unknown
 * buttons and unknown modules so a malformed or foreign preset can't wedge the
 * UI. Returns null if the basic shape is wrong.
 */
export function validatePreset(raw: unknown): Preset | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== "string" || typeof r.label !== "string") return null
  if (!Array.isArray(r.layout) || !Array.isArray(r.activeModules)) return null

  const layout = (r.layout as unknown[]).filter(
    (b): b is ActivityButton =>
      !!b &&
      typeof b === "object" &&
      typeof (b as ActivityButton).defId === "string" &&
      !!findButtonDef((b as ActivityButton).defId),
  )
  const known = new Set(ALL_MODULE_IDS)
  const activeModules = (r.activeModules as unknown[]).filter(
    (m): m is string => typeof m === "string" && known.has(m),
  )
  const side = (r.activeBySide ?? {}) as Record<string, PanelId | null>
  return {
    id: r.id,
    label: r.label,
    locked: false,
    activeModules,
    layout,
    activeBySide: { left: side.left ?? null, right: side.right ?? null },
  }
}

/**
 * The buttons of a preset's layout whose defId is contributed by one of its
 * active modules — so a layout can carry buttons that stay hidden until their
 * module is enabled.
 */
export function visibleLayout(preset: Preset): ActivityButton[] {
  const allowed = contributedDefIds(preset.activeModules)
  return preset.layout.filter(b => allowed.has(b.defId))
}

// ── Import / export ─────────────────────────────────────────────────────────

/** On-disk shape of an exported preset (the unit of sharing/selling). */
interface PresetFile {
  format: "amby-preset"
  version: 1
  preset: Pick<Preset, "id" | "label" | "activeModules" | "layout" | "activeBySide">
}

/** Serialize a preset to the shareable JSON file format. */
export function serializePreset(preset: Preset): string {
  const file: PresetFile = {
    format: "amby-preset",
    version: 1,
    preset: {
      id: preset.id,
      label: preset.label,
      activeModules: preset.activeModules,
      layout: preset.layout,
      activeBySide: preset.activeBySide,
    },
  }
  return JSON.stringify(file, null, 2)
}

/** Parse + validate a preset from exported JSON (wrapped) or a bare preset. */
export function parsePresetFile(text: string): Preset | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  const wrapped =
    data && typeof data === "object" && "preset" in (data as Record<string, unknown>)
      ? (data as Record<string, unknown>).preset
      : data
  return validatePreset(wrapped)
}

