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
  storeAiCredential,
  inspectAiCredential,
} from "@/lib/storage"
import { errorType, logger } from "@/lib/logger"
import type { VaultRecord } from "./workspace-picker"
import type { ActivityButton, PanelId, Side } from "./panel-registry"
import type { Preset } from "./presets"
import type { AiConfig, AiFamily } from "@/lib/ai"
import i18n, { SUPPORTED_LANGUAGES, type LanguageCode } from "@/lib/i18n"
import { BUILTIN_THEMES, isThemeId, parseThemeDefinition, type ThemeDefinition } from "@/lib/themes"

export const WORKSPACES_FILE = "workspaces.json"
export const SETTINGS_FILE = "settings.json"
export const WORKSPACE_FILE = "workspace.json"
export const SESSION_FILE = "session.json"

export const SETTINGS_SCHEMA_VERSION = 1
export const WORKSPACE_SCHEMA_VERSION = 1
export const SESSION_SCHEMA_VERSION = 1
export const WORKSPACES_SCHEMA_VERSION = 1

export const SETTINGS_SAVE_ERROR_EVENT = "amby:settings-save-error"

export function emitSettingsSaveError(fileName: string, error: unknown): void {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "")
  logger.error("settings.save_failed", {
    file: safeName,
    errorType: errorType(error),
  })
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(SETTINGS_SAVE_ERROR_EVENT, {
        detail: {
          file: safeName,
          message: i18n.t("errors.settingsSaveError"),
        },
      }),
    )
  }
}

// Several controls can update separate settings fields during the same event
// (for example, importing a theme selects it and adds it to the library).
// Serialize read-modify-write cycles so one asynchronous save cannot erase the
// other field from settings.json.
let settingsWriteChain: Promise<void> = Promise.resolve()
let workspaceConfigWriteChain: Promise<void> = Promise.resolve()
let sessionWriteChain: Promise<void> = Promise.resolve()

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
  schemaVersion: number
  recent: VaultRecord[]
  lastOpened: string | null
}

export async function loadWorkspaces(): Promise<WorkspacesFile> {
  if (await globalFileMissing(WORKSPACES_FILE)) {
    const recent = parseLS<VaultRecord[]>("amby:vaults", Array.isArray) ?? []
    const lastOpened = readLS("amby:vault")
    const file: WorkspacesFile = {
      schemaVersion: WORKSPACES_SCHEMA_VERSION,
      recent,
      lastOpened,
    }
    if (recent.length || lastOpened) await saveGlobalJSON(WORKSPACES_FILE, file)
    return file
  }
  const d = await loadGlobalJSON<Partial<WorkspacesFile>>(WORKSPACES_FILE, {
    schemaVersion: WORKSPACES_SCHEMA_VERSION,
    recent: [],
    lastOpened: null,
  })
  return {
    schemaVersion:
      typeof d.schemaVersion === "number" ? d.schemaVersion : WORKSPACES_SCHEMA_VERSION,
    recent: Array.isArray(d.recent) ? d.recent : [],
    lastOpened: typeof d.lastOpened === "string" ? d.lastOpened : null,
  }
}

export async function saveWorkspaces(file: WorkspacesFile): Promise<void> {
  try {
    await saveGlobalJSON(WORKSPACES_FILE, {
      ...file,
      schemaVersion: WORKSPACES_SCHEMA_VERSION,
    })
  } catch (err) {
    emitSettingsSaveError(WORKSPACES_FILE, err)
    throw err
  }
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
  credentialId?: string | null
  /** Azure only. */
  apiVersion: string
}

/** AI settings = a library of models + which one is active. Secrets are stored
 *  in the OS Keychain / Credential Manager under credentialId. */
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
      credentialId: null,
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
    credentialId: null,
    apiVersion: "",
  }
}

// ── App preferences (the user-facing Settings screen) ───────────────────────

/** Editor view modes — kept as a local union to avoid importing the heavy
 *  document-editor module just for its type. Mirrors DocumentViewMode. */
export type ViewModePref = "source" | "live" | "read"
/** `system`, a bundled id, or an imported portable theme id. */
export type ThemePref = string
export type AccentId = "violet" | "sky" | "teal" | "emerald" | "amber" | "rose"
export type FontScale = "sm" | "md" | "lg"
export type Density = "comfortable" | "compact"
export type Language = LanguageCode
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
  const storedTheme = d.theme ?? legacyTheme
  const autosaveMs =
    typeof ed.autosaveMs === "number" && ed.autosaveMs >= 200 && ed.autosaveMs <= 10000
      ? ed.autosaveMs
      : DEFAULT_PREFS.editor.autosaveMs
  return {
    // Migrate pre-prefs `defaultTheme` if no explicit theme was stored yet.
    theme: isThemeId(storedTheme) || storedTheme === "system" ? storedTheme : "dark",
    accent: oneOf<AccentId>(d.accent, ACCENTS, DEFAULT_PREFS.accent),
    fontScale: oneOf<FontScale>(d.fontScale, ["sm", "md", "lg"], DEFAULT_PREFS.fontScale),
    density: oneOf<Density>(d.density, ["comfortable", "compact"], DEFAULT_PREFS.density),
    language: oneOf<Language>(
      d.language,
      SUPPORTED_LANGUAGES.map((language) => language.code),
      DEFAULT_PREFS.language,
    ),
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
  }
}

export interface GlobalSettings {
  schemaVersion: number
  panelScope: PanelScope
  defaultTheme: string | null
  /** Used when panelScope === "global". */
  layout: LayoutConfig
  ai: AiSettings
  prefs: AppPreferences
  /** Globally installed user themes. Only validated portable JSON is persisted. */
  themes: ThemeDefinition[]
}

export async function migrateLegacyAiKeys(
  rawAi: unknown,
): Promise<{ ai: AiSettings; migrated: boolean }> {
  if (!rawAi || typeof rawAi !== "object") {
    return { ai: DEFAULT_AI, migrated: false }
  }
  const d = rawAi as { models?: unknown[]; activeModelId?: unknown }
  if (!Array.isArray(d.models)) {
    return { ai: DEFAULT_AI, migrated: false }
  }
  let migrated = false
  const models: AiModel[] = []
  for (const raw of d.models) {
    if (!raw || typeof raw !== "object") continue
    const m = raw as Partial<AiModel> & { apiKey?: string }
    if (typeof m.id !== "string" || typeof m.provider !== "string") continue
    let credId = typeof m.credentialId === "string" ? m.credentialId : null
    const legacyKey = typeof m.apiKey === "string" ? m.apiKey.trim() : ""
    if (legacyKey && !credId) {
      const newCredId = crypto.randomUUID()
      try {
        await storeAiCredential(newCredId, legacyKey)
        const info = await inspectAiCredential(newCredId)
        if (info.exists) {
          credId = newCredId
          migrated = true
        }
      } catch (err) {
        logger.error("settings.credential_migration_failed", {
          modelId: m.id,
          errorType: errorType(err),
        })
      }
    } else if (legacyKey && credId) {
      migrated = true
    }
    models.push({
      id: m.id,
      label: typeof m.label === "string" && m.label ? m.label : i18n.t("workspace.modelFallback"),
      provider: m.provider,
      model: typeof m.model === "string" ? m.model : "",
      baseUrl: typeof m.baseUrl === "string" ? m.baseUrl : "",
      credentialId: credId,
      apiVersion: typeof m.apiVersion === "string" ? m.apiVersion : "",
    })
  }
  if (models.length === 0) {
    return { ai: DEFAULT_AI, migrated }
  }
  const activeModelId =
    typeof d.activeModelId === "string" && models.some((m) => m.id === d.activeModelId)
      ? d.activeModelId
      : models[0].id
  return { ai: { models, activeModelId }, migrated }
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
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      panelScope: "global",
      defaultTheme: null,
      layout,
      ai: DEFAULT_AI,
      prefs: DEFAULT_PREFS,
      themes: [],
    }
    if (layout.activePresetId || layout.buttons || layout.activeBySide) {
      await saveGlobalJSON(SETTINGS_FILE, settings)
    }
    return settings
  }
  const d = await loadGlobalJSON<Partial<GlobalSettings>>(SETTINGS_FILE, {})
  const legacyTheme = typeof d.defaultTheme === "string" ? d.defaultTheme : null
  const themes = Array.isArray(d.themes)
    ? d.themes.map(parseThemeDefinition).filter((theme): theme is ThemeDefinition => !!theme)
    : []
  const prefs = normalizeAppPreferences(d.prefs, legacyTheme)
  if (
    !BUILTIN_THEMES.some((theme) => theme.id === prefs.theme) &&
    !themes.some((theme) => theme.id === prefs.theme)
  ) {
    prefs.theme = "dark"
  }
  const { ai, migrated } = await migrateLegacyAiKeys(d.ai)
  const settings: GlobalSettings = {
    schemaVersion: typeof d.schemaVersion === "number" ? d.schemaVersion : SETTINGS_SCHEMA_VERSION,
    panelScope: d.panelScope === "workspace" ? "workspace" : "global",
    defaultTheme: legacyTheme,
    layout: { ...EMPTY_LAYOUT, ...(d.layout ?? {}) },
    ai,
    prefs,
    themes,
  }
  if (migrated) {
    await saveGlobalJSON(SETTINGS_FILE, settings)
  }
  return settings
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
    credentialId: model.credentialId || null,
    maxTokens: 1024,
    apiVersion: family === "azure" ? model.apiVersion || "2024-06-01" : null,
  }
}

export function saveSettingsPatch(patch: Partial<GlobalSettings>): Promise<void> {
  const write = async () => {
    const cur = await loadSettings()
    await saveGlobalJSON(SETTINGS_FILE, {
      ...cur,
      ...patch,
      schemaVersion: SETTINGS_SCHEMA_VERSION,
    })
  }
  const next = settingsWriteChain.then(write, write)
  settingsWriteChain = next.catch((err) => {
    emitSettingsSaveError(SETTINGS_FILE, err)
  })
  return next
}

// ── Per-vault: workspace.json (requires an open vault) ───────────────────────

export interface WorkspaceConfig {
  schemaVersion: number
  theme: string | null
  customPresets: Preset[]
  /** Used when panelScope === "workspace". */
  layout: LayoutConfig
  confirmations: {
    /** Keep destructive file-delete confirmation visible unless this workspace opts out. */
    confirmFileDelete: boolean
  }
}

export async function loadWorkspaceConfig(): Promise<WorkspaceConfig> {
  if (await vaultFileMissing(WORKSPACE_FILE)) {
    // Custom presets were a single global list pre-tier; each vault inherits a copy.
    const customPresets = parseLS<Preset[]>("amby:user-presets:v1", Array.isArray) ?? []
    const cfg: WorkspaceConfig = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      theme: null,
      customPresets,
      layout: EMPTY_LAYOUT,
      confirmations: { confirmFileDelete: true },
    }
    if (customPresets.length) await saveVaultJSON(WORKSPACE_FILE, cfg)
    return cfg
  }
  const d = await loadVaultJSON<Partial<WorkspaceConfig>>(WORKSPACE_FILE, {})
  return {
    schemaVersion: typeof d.schemaVersion === "number" ? d.schemaVersion : WORKSPACE_SCHEMA_VERSION,
    theme: typeof d.theme === "string" ? d.theme : null,
    customPresets: Array.isArray(d.customPresets) ? d.customPresets : [],
    layout: { ...EMPTY_LAYOUT, ...(d.layout ?? {}) },
    confirmations: {
      confirmFileDelete:
        typeof d.confirmations?.confirmFileDelete === "boolean"
          ? d.confirmations.confirmFileDelete
          : true,
    },
  }
}

export function saveWorkspaceConfigPatch(patch: Partial<WorkspaceConfig>): Promise<void> {
  const write = async () => {
    const cur = await loadWorkspaceConfig()
    await saveVaultJSON(WORKSPACE_FILE, {
      ...cur,
      ...patch,
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
    })
  }
  const next = workspaceConfigWriteChain.then(write, write)
  workspaceConfigWriteChain = next.catch((err) => {
    emitSettingsSaveError(WORKSPACE_FILE, err)
  })
  return next
}

// ── Per-vault: session.json (requires an open vault) ─────────────────────────

/** Session memory restored when a vault re-opens. `viewModes` values are the
 *  editor's DocumentViewMode (kept as string here to avoid a UI-type import). */
export interface SessionFile {
  schemaVersion: number
  tabs: { fileId: string; title: string }[]
  activeFileId: string
  favorites: string[]
  viewModes: Record<string, string>
  nestedNotesPlacements: Record<string, string>
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
      schemaVersion: SESSION_SCHEMA_VERSION,
      tabs: Array.isArray(t?.entries) ? t!.entries : [],
      activeFileId: typeof t?.activeFileId === "string" ? t!.activeFileId : "",
      favorites: parseLS<string[]>(`amby:favorites:${vaultPath}`, Array.isArray) ?? [],
      viewModes: parseLS<Record<string, string>>(`amby:view-modes:${vaultPath}`, isRecord) ?? {},
      nestedNotesPlacements: {},
      locked: parseLS<string[]>(`amby:locked:${vaultPath}`, Array.isArray) ?? [],
      icons: parseLS<Record<string, string>>("amby:icons", isRecord) ?? {},
    }
    const hasAny =
      session.tabs.length ||
      session.favorites.length ||
      session.locked.length ||
      Object.keys(session.viewModes).length ||
      Object.keys(session.nestedNotesPlacements).length ||
      Object.keys(session.icons).length
    if (hasAny) await saveVaultJSON(SESSION_FILE, session)
    return session
  }
  const d = await loadVaultJSON<Partial<SessionFile>>(SESSION_FILE, {})
  return {
    schemaVersion: typeof d.schemaVersion === "number" ? d.schemaVersion : SESSION_SCHEMA_VERSION,
    tabs: Array.isArray(d.tabs) ? d.tabs : [],
    activeFileId: typeof d.activeFileId === "string" ? d.activeFileId : "",
    favorites: Array.isArray(d.favorites) ? d.favorites : [],
    viewModes: isRecord(d.viewModes) ? d.viewModes : {},
    nestedNotesPlacements: isRecord(d.nestedNotesPlacements) ? d.nestedNotesPlacements : {},
    locked: Array.isArray(d.locked) ? d.locked : [],
    icons: isRecord(d.icons) ? d.icons : {},
  }
}

export function saveSession(session: SessionFile): Promise<void> {
  const write = async () => {
    const persisted = await loadVaultJSON<Partial<SessionFile>>(SESSION_FILE, {})
    const persistedIcons = isRecord(persisted.icons) ? persisted.icons : {}
    await saveVaultJSON(SESSION_FILE, {
      ...session,
      schemaVersion: SESSION_SCHEMA_VERSION,
      // Icon choices are durable workspace metadata. A transient empty store
      // during development HMR must not erase every file emoji.
      icons: { ...persistedIcons, ...session.icons },
    })
  }
  const next = sessionWriteChain.then(write, write)
  sessionWriteChain = next.catch((err) => {
    emitSettingsSaveError(SESSION_FILE, err)
  })
  return next
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
