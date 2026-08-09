//! Domain layer over the tiered storage (`@/lib/storage`): defines what config
//! lives where and migrates pre-tier `localStorage` data on first read.
//!
//!   Global  ({local_data_dir}/Amby/)
//!     workspaces.json  — recent vaults + last opened
//!     settings.json    — panelScope, default theme, global layout
//!   Per-vault ({vault}/.amby/)
//!     workspace.json   — workspace theme, custom presets, workspace layout
//!     session.json     — open tabs/favorites/view-modes/locked/icons (see workspace.tsx)

import {
  globalFileMissing,
  loadGlobalJSON,
  loadVaultJSON,
  saveGlobalJSON,
  saveVaultJSON,
  vaultFileMissing,
} from "@/lib/storage"
import type { VaultRecord } from "./workspace-picker"
import type { ActivityButton, PanelId, Side } from "./panel-registry"
import type { Preset } from "./presets"
import type { AiConfig, AiFamily } from "@/lib/ai"
import i18n from "@/lib/i18n"

export const WORKSPACES_FILE = "workspaces.json"
export const SETTINGS_FILE = "settings.json"
export const WORKSPACE_FILE = "workspace.json"
export const SESSION_FILE = "session.json"

export type PanelScope = "global" | "workspace"

/** The activity-bar arrangement that the panelScope toggle routes global ⟷ vault. */
export interface LayoutConfig {
  activePresetId: string | null
  /** Explicit module selection for the active layout. Falls back to its preset for older settings. */
  activeModules: string[] | null
  buttons: ActivityButton[] | null
  activeBySide: Record<Side, PanelId | null> | null
}

const EMPTY_LAYOUT: LayoutConfig = {
  activePresetId: null,
  activeModules: null,
  buttons: null,
  activeBySide: null,
}

function readLS(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function parseLS<T>(key: string, guard: (v: unknown) => v is T): T | null {
  const raw = readLS(key)
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    return guard(v) ? v : null
  } catch {
    return null
  }
}

const isRecord = (v: unknown): v is Record<string, string> =>
  !!v && typeof v === "object" && !Array.isArray(v)

// ── Global: workspaces.json ─────────────────────────────────────────────────

export interface WorkspacesFile {
  recent: VaultRecord[]
  lastOpened: string | null
}

export async function loadWorkspaces(): Promise<WorkspacesFile> {
  if (await globalFileMissing(WORKSPACES_FILE)) {
    const recent = parseLS<VaultRecord[]>("amby:vaults", Array.isArray) ?? []
    const lastOpened = readLS("amby:vault")
    const file: WorkspacesFile = { recent, lastOpened }
    if (recent.length || lastOpened) await saveGlobalJSON(WORKSPACES_FILE, file)
    return file
  }
  const d = await loadGlobalJSON<WorkspacesFile>(WORKSPACES_FILE, { recent: [], lastOpened: null })
  return {
    recent: Array.isArray(d.recent) ? d.recent : [],
    lastOpened: typeof d.lastOpened === "string" ? d.lastOpened : null,
  }
}

export async function saveWorkspaces(file: WorkspacesFile): Promise<void> {
  await saveGlobalJSON(WORKSPACES_FILE, file)
}

// ── Global: settings.json ───────────────────────────────────────────────────

/** A selectable provider in the model editor. Maps a friendly name to a wire
 *  `family` (what Rust dispatches on) plus sensible connection defaults. */
export interface ProviderInfo {
  id: string
  label: string
  family: AiFamily
  kind: "local" | "cloud"
  defaultBaseUrl: string
  defaultModel: string
  needsKey: boolean
  /** Azure-only: the field is shown and a default offered. */
  azure?: boolean
}

/** Local options first (most popular), then cloud. */
export const AI_PROVIDERS: ProviderInfo[] = [
  {
    id: "ollama",
    label: "Ollama",
    family: "ollama",
    kind: "local",
    defaultBaseUrl: "http://localhost:11434",
    defaultModel: "llama3.2",
    needsKey: false,
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    family: "openai",
    kind: "local",
    defaultBaseUrl: "http://localhost:1234",
    defaultModel: "local-model",
    needsKey: false,
  },
  {
    id: "mlx",
    label: "MLX",
    family: "openai",
    kind: "local",
    defaultBaseUrl: "http://localhost:8080",
    defaultModel: "mlx-community/Llama-3.2-3B-Instruct-4bit",
    needsKey: false,
  },
  {
    id: "llamacpp",
    label: "llama.cpp",
    family: "openai",
    kind: "local",
    defaultBaseUrl: "http://localhost:8080",
    defaultModel: "default",
    needsKey: false,
  },
  {
    id: "openai",
    label: "OpenAI",
    family: "openai",
    kind: "cloud",
    defaultBaseUrl: "https://api.openai.com",
    defaultModel: "gpt-4o-mini",
    needsKey: true,
  },
  {
    id: "anthropic",
    label: "Anthropic",
    family: "anthropic",
    kind: "cloud",
    defaultBaseUrl: "https://api.anthropic.com",
    defaultModel: "claude-3-5-haiku-latest",
    needsKey: true,
  },
  {
    id: "azure",
    label: "Azure OpenAI",
    family: "azure",
    kind: "cloud",
    defaultBaseUrl: "",
    defaultModel: "",
    needsKey: true,
    azure: true,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    family: "openai",
    kind: "cloud",
    defaultBaseUrl: "https://openrouter.ai/api",
    defaultModel: "openai/gpt-4o-mini",
    needsKey: true,
  },
  {
    id: "groq",
    label: "Groq",
    family: "openai",
    kind: "cloud",
    defaultBaseUrl: "https://api.groq.com/openai",
    defaultModel: "llama-3.3-70b-versatile",
    needsKey: true,
  },
  {
    id: "mistral",
    label: "Mistral",
    family: "openai",
    kind: "cloud",
    defaultBaseUrl: "https://api.mistral.ai",
    defaultModel: "mistral-small-latest",
    needsKey: true,
  },
]

export function findProvider(id: string): ProviderInfo | undefined {
  return AI_PROVIDERS.find((p) => p.id === id)
}

/** One configured model in the user's library (the chat picks from these). */
export interface AiModel {
  id: string
  label: string
  /** ProviderInfo.id */
  provider: string
  model: string
  baseUrl: string
  apiKey: string
  /** Azure only. */
  apiVersion: string
}

/** AI settings = a library of models + which one is active. Keys are plaintext
 *  in settings.json (acceptable for v1; local providers need none). */
export interface AiSettings {
  models: AiModel[]
  activeModelId: string | null
}

export const DEFAULT_AI: AiSettings = {
  models: [
    {
      id: "default-ollama",
      label: "Ollama · llama3.2",
      provider: "ollama",
      model: "llama3.2",
      baseUrl: "",
      apiKey: "",
      apiVersion: "",
    },
  ],
  activeModelId: "default-ollama",
}

/** A fresh blank model entry (used by the "add model" button). */
export function blankModel(): AiModel {
  return {
    id: crypto.randomUUID(),
    label: i18n.t("workspace.newModel"),
    provider: "ollama",
    model: "llama3.2",
    baseUrl: "",
    apiKey: "",
    apiVersion: "",
  }
}

// ── App preferences (the user-facing Settings screen) ───────────────────────

/** Editor view modes — kept as a local union to avoid importing the heavy
 *  document-editor module just for its type. Mirrors DocumentViewMode. */
export type ViewModePref = "source" | "live" | "read"
export type ThemePref = "dark" | "light" | "system"
export type AccentId = "violet" | "sky" | "teal" | "emerald" | "amber" | "rose"
export type FontScale = "sm" | "md" | "lg"
export type Density = "comfortable" | "compact"
export type Language = "ru" | "en"
export type ContentWidth = "normal" | "wide" | "full"

export const ACCENTS: AccentId[] = ["violet", "sky", "teal", "emerald", "amber", "rose"]

export interface EditorPrefs {
  defaultViewMode: ViewModePref
  contentWidth: ContentWidth
  autosaveMs: number
}

export interface StartupPrefs {
  reopenLastVault: boolean
  restoreSession: boolean
}

export interface DockPreferences {
  leftVisible: boolean
  rightVisible: boolean
  leftPinned: boolean
  rightPinned: boolean
}

export interface ConfirmationPreferences {
  /** Keep destructive file-delete confirmation visible unless the user opts out. */
  confirmFileDelete: boolean
}

/** Everything the Settings screen controls. Lives in the global settings.json
 *  so it is shared across vaults. */
export interface AppPreferences {
  theme: ThemePref
  accent: AccentId
  fontScale: FontScale
  density: Density
  language: Language
  editor: EditorPrefs
  startup: StartupPrefs
  docks: DockPreferences
  confirmations: ConfirmationPreferences
}

export const DEFAULT_PREFS: AppPreferences = {
  theme: "dark",
  accent: "violet",
  fontScale: "md",
  density: "comfortable",
  language: "ru",
  editor: { defaultViewMode: "live", contentWidth: "normal", autosaveMs: 500 },
  startup: { reopenLastVault: true, restoreSession: true },
  docks: { leftVisible: true, rightVisible: true, leftPinned: true, rightPinned: true },
  confirmations: { confirmFileDelete: true },
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

export function normalizeAppPreferences(
  raw: unknown,
  legacyTheme: string | null = null,
): AppPreferences {
  const d = (raw ?? {}) as Partial<AppPreferences>
  const ed = (d.editor ?? {}) as Partial<EditorPrefs>
  const su = (d.startup ?? {}) as Partial<StartupPrefs>
  const dk = (d.docks ?? {}) as Partial<DockPreferences>
  const cf = (d.confirmations ?? {}) as Partial<ConfirmationPreferences>
  const autosaveMs =
    typeof ed.autosaveMs === "number" && ed.autosaveMs >= 200 && ed.autosaveMs <= 10000
      ? ed.autosaveMs
      : DEFAULT_PREFS.editor.autosaveMs
  return {
    // Migrate pre-prefs `defaultTheme` if no explicit theme was stored yet.
    theme: oneOf<ThemePref>(d.theme ?? legacyTheme, ["dark", "light", "system"], "dark"),
    accent: oneOf<AccentId>(d.accent, ACCENTS, DEFAULT_PREFS.accent),
    fontScale: oneOf<FontScale>(d.fontScale, ["sm", "md", "lg"], DEFAULT_PREFS.fontScale),
    density: oneOf<Density>(d.density, ["comfortable", "compact"], DEFAULT_PREFS.density),
    language: oneOf<Language>(d.language, ["ru", "en"], DEFAULT_PREFS.language),
    editor: {
      defaultViewMode: oneOf<ViewModePref>(ed.defaultViewMode, ["source", "live", "read"], "live"),
      contentWidth: oneOf<ContentWidth>(ed.contentWidth, ["normal", "wide", "full"], "normal"),
      autosaveMs,
    },
    startup: {
      reopenLastVault: typeof su.reopenLastVault === "boolean" ? su.reopenLastVault : true,
      restoreSession: typeof su.restoreSession === "boolean" ? su.restoreSession : true,
    },
    docks: {
      leftVisible: typeof dk.leftVisible === "boolean" ? dk.leftVisible : true,
      rightVisible: typeof dk.rightVisible === "boolean" ? dk.rightVisible : true,
      leftPinned: typeof dk.leftPinned === "boolean" ? dk.leftPinned : true,
      rightPinned: typeof dk.rightPinned === "boolean" ? dk.rightPinned : true,
    },
    confirmations: {
      confirmFileDelete: typeof cf.confirmFileDelete === "boolean" ? cf.confirmFileDelete : true,
    },
  }
}

export interface GlobalSettings {
  panelScope: PanelScope
  defaultTheme: string | null
  /** Used when panelScope === "global". */
  layout: LayoutConfig
  ai: AiSettings
  prefs: AppPreferences
}

function normalizeModel(raw: unknown): AiModel | null {
  if (!raw || typeof raw !== "object") return null
  const d = raw as Partial<AiModel>
  if (typeof d.id !== "string" || typeof d.provider !== "string") return null
  return {
    id: d.id,
    label: typeof d.label === "string" && d.label ? d.label : i18n.t("workspace.modelFallback"),
    provider: d.provider,
    model: typeof d.model === "string" ? d.model : "",
    baseUrl: typeof d.baseUrl === "string" ? d.baseUrl : "",
    apiKey: typeof d.apiKey === "string" ? d.apiKey : "",
    apiVersion: typeof d.apiVersion === "string" ? d.apiVersion : "",
  }
}

function normalizeAi(raw: unknown): AiSettings {
  const d = (raw ?? {}) as Partial<AiSettings>
  const models = Array.isArray(d.models)
    ? d.models.map(normalizeModel).filter((m): m is AiModel => !!m)
    : []
  if (models.length === 0) return DEFAULT_AI
  const activeModelId =
    typeof d.activeModelId === "string" && models.some((m) => m.id === d.activeModelId)
      ? d.activeModelId
      : models[0].id
  return { models, activeModelId }
}

export async function loadSettings(): Promise<GlobalSettings> {
  if (await globalFileMissing(SETTINGS_FILE)) {
    const layout: LayoutConfig = {
      activePresetId: readLS("amby:active-preset:v1"),
      activeModules: null,
      buttons: parseLS<ActivityButton[]>("amby:panel-buttons:v1", Array.isArray),
      activeBySide: parseLS<Record<Side, PanelId | null>>(
        "amby:active-views:v1",
        (v): v is Record<Side, PanelId | null> => !!v && typeof v === "object",
      ),
    }
    const settings: GlobalSettings = {
      panelScope: "global",
      defaultTheme: null,
      layout,
      ai: DEFAULT_AI,
      prefs: DEFAULT_PREFS,
    }
    if (layout.activePresetId || layout.buttons || layout.activeBySide) {
      await saveGlobalJSON(SETTINGS_FILE, settings)
    }
    return settings
  }
  const d = await loadGlobalJSON<Partial<GlobalSettings>>(SETTINGS_FILE, {})
  const legacyTheme = typeof d.defaultTheme === "string" ? d.defaultTheme : null
  return {
    panelScope: d.panelScope === "workspace" ? "workspace" : "global",
    defaultTheme: legacyTheme,
    layout: { ...EMPTY_LAYOUT, ...(d.layout ?? {}) },
    ai: normalizeAi(d.ai),
    prefs: normalizeAppPreferences(d.prefs, legacyTheme),
  }
}

/** The currently-active model in the library, or null if none configured. */
export function activeModel(ai: AiSettings): AiModel | null {
  return ai.models.find((m) => m.id === ai.activeModelId) ?? ai.models[0] ?? null
}

/** Resolve a model entry to the flat `AiConfig` the `aiChat` command expects,
 *  filling provider defaults for any blank connection fields. */
export function resolveAiConfig(model: AiModel): AiConfig {
  const p = findProvider(model.provider)
  const family: AiFamily = p?.family ?? "ollama"
  return {
    provider: family,
    model: model.model || p?.defaultModel || "",
    baseUrl: model.baseUrl || p?.defaultBaseUrl || "",
    apiKey: model.apiKey || null,
    maxTokens: 1024,
    apiVersion: family === "azure" ? model.apiVersion || "2024-06-01" : null,
  }
}

export async function saveSettingsPatch(patch: Partial<GlobalSettings>): Promise<void> {
  const cur = await loadSettings()
  await saveGlobalJSON(SETTINGS_FILE, { ...cur, ...patch })
}

// ── Per-vault: workspace.json (requires an open vault) ───────────────────────

export interface WorkspaceConfig {
  theme: string | null
  customPresets: Preset[]
  /** Used when panelScope === "workspace". */
  layout: LayoutConfig
}

export async function loadWorkspaceConfig(): Promise<WorkspaceConfig> {
  if (await vaultFileMissing(WORKSPACE_FILE)) {
    // Custom presets were a single global list pre-tier; each vault inherits a copy.
    const customPresets = parseLS<Preset[]>("amby:user-presets:v1", Array.isArray) ?? []
    const cfg: WorkspaceConfig = { theme: null, customPresets, layout: EMPTY_LAYOUT }
    if (customPresets.length) await saveVaultJSON(WORKSPACE_FILE, cfg)
    return cfg
  }
  const d = await loadVaultJSON<Partial<WorkspaceConfig>>(WORKSPACE_FILE, {})
  return {
    theme: typeof d.theme === "string" ? d.theme : null,
    customPresets: Array.isArray(d.customPresets) ? d.customPresets : [],
    layout: { ...EMPTY_LAYOUT, ...(d.layout ?? {}) },
  }
}

export async function saveWorkspaceConfigPatch(patch: Partial<WorkspaceConfig>): Promise<void> {
  const cur = await loadWorkspaceConfig()
  await saveVaultJSON(WORKSPACE_FILE, { ...cur, ...patch })
}

// ── Per-vault: session.json (requires an open vault) ─────────────────────────

/** Session memory restored when a vault re-opens. `viewModes` values are the
 *  editor's DocumentViewMode (kept as string here to avoid a UI-type import). */
export interface SessionFile {
  tabs: { fileId: string; title: string }[]
  activeFileId: string
  favorites: string[]
  viewModes: Record<string, string>
  locked: string[]
  icons: Record<string, string>
}

export async function loadSession(vaultPath: string): Promise<SessionFile> {
  if (await vaultFileMissing(SESSION_FILE)) {
    // Migrate pre-tier localStorage: per-vault keys (suffixed by the vault path)
    // plus the formerly-global icons map.
    const t = parseLS<{ entries?: { fileId: string; title: string }[]; activeFileId?: string }>(
      `amby:tabs:${vaultPath}`,
      (v): v is { entries?: { fileId: string; title: string }[]; activeFileId?: string } =>
        !!v && typeof v === "object",
    )
    const session: SessionFile = {
      tabs: Array.isArray(t?.entries) ? t!.entries : [],
      activeFileId: typeof t?.activeFileId === "string" ? t!.activeFileId : "",
      favorites: parseLS<string[]>(`amby:favorites:${vaultPath}`, Array.isArray) ?? [],
      viewModes: parseLS<Record<string, string>>(`amby:view-modes:${vaultPath}`, isRecord) ?? {},
      locked: parseLS<string[]>(`amby:locked:${vaultPath}`, Array.isArray) ?? [],
      icons: parseLS<Record<string, string>>("amby:icons", isRecord) ?? {},
    }
    const hasAny =
      session.tabs.length ||
      session.favorites.length ||
      session.locked.length ||
      Object.keys(session.viewModes).length ||
      Object.keys(session.icons).length
    if (hasAny) await saveVaultJSON(SESSION_FILE, session)
    return session
  }
  const d = await loadVaultJSON<Partial<SessionFile>>(SESSION_FILE, {})
  return {
    tabs: Array.isArray(d.tabs) ? d.tabs : [],
    activeFileId: typeof d.activeFileId === "string" ? d.activeFileId : "",
    favorites: Array.isArray(d.favorites) ? d.favorites : [],
    viewModes: isRecord(d.viewModes) ? d.viewModes : {},
    locked: Array.isArray(d.locked) ? d.locked : [],
    icons: isRecord(d.icons) ? d.icons : {},
  }
}

export async function saveSession(session: SessionFile): Promise<void> {
  await saveVaultJSON(SESSION_FILE, session)
}

// ── Layout routing by panelScope ────────────────────────────────────────────

export async function loadLayout(scope: PanelScope, hasVault: boolean): Promise<LayoutConfig> {
  if (scope === "workspace" && hasVault) return (await loadWorkspaceConfig()).layout
  return (await loadSettings()).layout
}

export async function saveLayout(
  scope: PanelScope,
  hasVault: boolean,
  layout: LayoutConfig,
): Promise<void> {
  if (scope === "workspace" && hasVault) {
    await saveWorkspaceConfigPatch({ layout })
    return
  }
  await saveSettingsPatch({ layout })
}
