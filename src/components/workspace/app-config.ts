//! Domain layer over the tiered storage (`@/lib/storage`): defines what config
//! lives where and migrates pre-tier `localStorage` data on first read.
//!
//!   Global  ({local_data_dir}/Amby/)
//!     workspaces.json  — recent vaults + last opened
//!     settings.json    — panelScope, default theme, global layout
//!   Per-vault ({vault}/.amby/)
//!     workspace.json   — workspace theme, custom presets, workspace layout
//!     session.json     — open tabs/favorites/view-modes/content-widths/database labels/locked/icons

import {
  globalFileMissing,
  isTauri,
  migrateAiSettings,
  readGlobalRaw,
  compareWriteGlobalRaw,
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
import { findProvider, type AiModel, type AiSettings } from "./ai/providers"
import { projectAiConnections, readAiConnections, serializeAiSettings } from "./ai/connections"
export {
  AI_PROVIDERS,
  findProvider,
  type AiModel,
  type AiSettings,
  type ProviderInfo,
} from "./ai/providers"
import i18n, { SUPPORTED_LANGUAGES, type LanguageCode } from "@/lib/i18n"
import {
  BUILTIN_THEMES,
  isThemeId,
  migrateThemeId,
  parseThemeDefinition,
  type ThemeDefinition,
} from "@/lib/themes"
import {
  DEFAULT_SHORTCUTS,
  normalizeShortcutBindings,
  type ShortcutBindings,
} from "./keyboard-shortcuts"
import {
  applyProfileToWorkspace,
  migrateWorkspaceModules,
  type ProfileId,
  type WorkspaceProfileState,
} from "@/lib/modules"
import type { DebugConfig } from "@/lib/debug/types"

export const WORKSPACES_FILE = "workspaces.json"
export const SETTINGS_FILE = "settings.json"
export const WORKSPACE_FILE = "workspace.json"
export const SESSION_FILE = "session.json"

export const SETTINGS_SCHEMA_VERSION = 1
export const WORKSPACE_SCHEMA_VERSION = 1
export const SESSION_SCHEMA_VERSION = 1
export const WORKSPACES_SCHEMA_VERSION = 1

export const SETTINGS_SAVE_ERROR_EVENT = "amby:settings-save-error"
export const AI_SETTINGS_CHANGED_EVENT = "amby:ai-settings-changed"

export function emitSettingsSaveError(fileName: string, error: unknown): void {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "")
  logger.error("settings.save_failed", {
    file: safeName,
    errorType: errorType(error),
    // Our own error codes ("settingsChanged", "unsupportedAiVersion"); never free text.
    code: /^[A-Za-z]{3,40}$/.test((error as Error)?.message ?? "")
      ? (error as Error).message
      : undefined,
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

/** Moving a model entry to another provider starts from that provider's own model and
 *  endpoint: a name or URL left over from the previous provider would be rejected there. */
export function changeProvider(model: AiModel, providerId: string): AiModel {
  const provider = findProvider(providerId)
  if (!provider || model.provider === providerId) return model
  const codex = providerId === "codex" || providerId === "claude-code"
  return {
    ...model,
    provider: providerId,
    model: codex ? "" : provider.defaultModel,
    baseUrl: "",
    supportsTools: undefined,
    apiVersion: provider.azure ? model.apiVersion : "",
  }
}

/** Agent mode: the conversation goes to the user's own Codex, not to an endpoint. */
export function isCodexModel(model: AiModel): boolean {
  return model.provider === "codex"
}

/** Agent mode through Claude Code: same boundary as Codex, a different account and CLI. */
export function isClaudeCodeModel(model: AiModel): boolean {
  return model.provider === "claude-code"
}

/** Either signed-in command-line agent: no endpoint, no key, consent before any turn. */
export function isCliAgentModel(model: AiModel): boolean {
  return isCodexModel(model) || isClaudeCodeModel(model)
}

/** One hint for the settings screen, from what the backend found on this machine. */
export function codexStatusKey(status: {
  installed: boolean
  supported: boolean
  signedIn: boolean
}): "missing" | "unsupported" | "signedOut" | "ready" {
  if (!status.installed) return "missing"
  if (!status.supported) return "unsupported"
  return status.signedIn ? "ready" : "signedOut"
}

/** Classify only addresses known to stay on a local network as local. */
export function isLocalAiModel(model: AiModel): boolean {
  if (isCliAgentModel(model)) return false
  const provider = findProvider(model.provider)
  const address = model.baseUrl.trim() || provider?.defaultBaseUrl || ""
  if (!address) return provider?.kind === "local"
  try {
    const host = new URL(address).hostname.toLowerCase().replace(/^\[|\]$/g, "")
    if (host === "localhost" || host.endsWith(".localhost")) return true
    if (host === "::1" || /^(?:fc|fd)[0-9a-f]*:/i.test(host)) return true
    const parts = host.split(".").map(Number)
    if (
      parts.length !== 4 ||
      parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
    )
      return false
    return (
      parts[0] === 127 ||
      parts[0] === 10 ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    )
  } catch {
    return false
  }
}

export function modelSupportsTools(model: AiModel): boolean {
  return model.supportsTools ?? !isLocalAiModel(model)
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
export type FontFamily = "system" | "sans" | "serif" | "mono"
export type Density = "comfortable" | "compact"
export type Language = LanguageCode
export type ContentWidth = "normal" | "wide" | "full"

export const ACCENTS: AccentId[] = ["violet", "sky", "teal", "emerald", "amber", "rose"]

export interface EditorPrefs {
  defaultViewMode: ViewModePref
  contentWidth: ContentWidth
  autosaveMs: number
  showAreaControls?: boolean
}

export type DeleteModePref = "system" | "vault" | "permanent"
export const DELETE_MODES: DeleteModePref[] = ["system", "vault", "permanent"]
export type UpdateChannelPref = "stable" | "beta"

export interface FilePrefs {
  /** Where deleting a file sends it. `permanent` always asks for confirmation. */
  deleteMode: DeleteModePref
}

export interface StartupPrefs {
  reopenLastVault: boolean
  restoreSession: boolean
}

export interface UpdatePrefs {
  /** Check the selected release channel at launch and install a newer signed update. */
  autoUpdate: boolean
  /** Release channel used for manual and automatic update checks. */
  channel: UpdateChannelPref
}

export type LogLevelPref = DebugConfig["logLevel"]
export type DebugPrefs = DebugConfig

export const DEFAULT_DEBUG_PREFS: DebugPrefs = {
  enabled: false,
  logLevel: "info",
  logToFile: false,
}

export interface DockPreferences {
  leftPinned: boolean
  rightPinned: boolean
  /** Off removes the right dock, its panel and its toggle; its buttons join the left dock. */
  rightEnabled: boolean
}

export const PANEL_WIDTH_MIN = 250
export const PANEL_WIDTH_MAX = 520
export const DEFAULT_PANEL_WIDTH = 300

export interface WindowPreferences {
  width: number
  height: number
  leftPanelWidth: number
  rightPanelWidth: number
  maximized: boolean
}

/** Everything the Settings screen controls. Lives in the global settings.json
 *  so it is shared across vaults. */
export interface AppPreferences {
  theme: ThemePref
  accent: AccentId
  fontScale: FontScale
  fontFamily: FontFamily
  rainbowTree: boolean
  treeGuides: boolean
  /** The file tree follows the open file: its folders open and it is scrolled to. */
  autoRevealFile: boolean
  /** Bookmarks are listed in a block above the file tree (needs the favorites module). */
  favoritesInTree: boolean
  /** Bookmarks also get a tab of their own on the dock (needs the favorites module). */
  favoritesPanel: boolean
  density: Density
  tooltipDelayMs: number
  language: Language
  editor: EditorPrefs
  startup: StartupPrefs
  files: FilePrefs
  updates: UpdatePrefs
  debug: DebugPrefs
  docks: DockPreferences
  window: WindowPreferences
  shortcuts: ShortcutBindings
}

export const DEFAULT_PREFS: AppPreferences = {
  theme: "dark",
  accent: "violet",
  fontScale: "md",
  fontFamily: "system",
  rainbowTree: false,
  treeGuides: true,
  autoRevealFile: false,
  favoritesInTree: true,
  favoritesPanel: false,
  density: "comfortable",
  tooltipDelayMs: 1000,
  language: "ru",
  editor: {
    defaultViewMode: "live",
    contentWidth: "normal",
    autosaveMs: 500,
    showAreaControls: true,
  },
  startup: { reopenLastVault: true, restoreSession: true },
  files: { deleteMode: "system" },
  updates: { autoUpdate: true, channel: "stable" },
  debug: { ...DEFAULT_DEBUG_PREFS },
  docks: { leftPinned: true, rightPinned: true, rightEnabled: true },
  window: {
    width: 1280,
    height: 800,
    leftPanelWidth: DEFAULT_PANEL_WIDTH,
    rightPanelWidth: DEFAULT_PANEL_WIDTH,
    maximized: false,
  },
  shortcuts: { ...DEFAULT_SHORTCUTS },
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

function boundedNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.max(min, Math.min(max, value)))
    : fallback
}

export function normalizeAppPreferences(
  raw: unknown,
  legacyTheme: string | null = null,
): AppPreferences {
  const d = (raw ?? {}) as Partial<AppPreferences>
  const ed = (d.editor ?? {}) as Partial<EditorPrefs>
  const su = (d.startup ?? {}) as Partial<StartupPrefs>
  const up = (d.updates ?? {}) as Partial<UpdatePrefs>
  const fi = (d.files ?? {}) as Partial<FilePrefs>
  const dbg = (d.debug ?? {}) as Partial<DebugPrefs>
  const dk = (d.docks ?? {}) as Partial<DockPreferences>
  const wi = (d.window ?? {}) as Partial<WindowPreferences>
  const storedTheme = d.theme ?? legacyTheme
  const migratedTheme = typeof storedTheme === "string" ? migrateThemeId(storedTheme) : storedTheme
  const autosaveMs =
    typeof ed.autosaveMs === "number" && ed.autosaveMs >= 200 && ed.autosaveMs <= 10000
      ? ed.autosaveMs
      : DEFAULT_PREFS.editor.autosaveMs
  const legacyTooltipDelay = Number(readLS("amby:tooltip-delay-ms"))
  const tooltipDelayMs =
    typeof d.tooltipDelayMs === "number" && d.tooltipDelayMs >= -1
      ? d.tooltipDelayMs
      : Number.isFinite(legacyTooltipDelay) && legacyTooltipDelay >= -1
        ? legacyTooltipDelay
        : DEFAULT_PREFS.tooltipDelayMs
  return {
    // Migrate pre-prefs `defaultTheme` if no explicit theme was stored yet.
    theme: isThemeId(migratedTheme) || migratedTheme === "system" ? migratedTheme : "dark",
    accent: oneOf<AccentId>(d.accent, ACCENTS, DEFAULT_PREFS.accent),
    fontScale: oneOf<FontScale>(d.fontScale, ["sm", "md", "lg"], DEFAULT_PREFS.fontScale),
    fontFamily: oneOf<FontFamily>(
      d.fontFamily,
      ["system", "sans", "serif", "mono"],
      DEFAULT_PREFS.fontFamily,
    ),
    rainbowTree: typeof d.rainbowTree === "boolean" ? d.rainbowTree : false,
    treeGuides: typeof d.treeGuides === "boolean" ? d.treeGuides : true,
    autoRevealFile: typeof d.autoRevealFile === "boolean" ? d.autoRevealFile : false,
    favoritesInTree: typeof d.favoritesInTree === "boolean" ? d.favoritesInTree : true,
    favoritesPanel: typeof d.favoritesPanel === "boolean" ? d.favoritesPanel : false,
    density: oneOf<Density>(d.density, ["comfortable", "compact"], DEFAULT_PREFS.density),
    tooltipDelayMs,
    language: oneOf<Language>(
      d.language,
      SUPPORTED_LANGUAGES.map((language) => language.code),
      DEFAULT_PREFS.language,
    ),
    editor: {
      defaultViewMode: oneOf<ViewModePref>(ed.defaultViewMode, ["source", "live", "read"], "live"),
      contentWidth: oneOf<ContentWidth>(ed.contentWidth, ["normal", "wide", "full"], "normal"),
      autosaveMs,
      showAreaControls: typeof ed.showAreaControls === "boolean" ? ed.showAreaControls : true,
    },
    startup: {
      reopenLastVault: typeof su.reopenLastVault === "boolean" ? su.reopenLastVault : true,
      restoreSession: typeof su.restoreSession === "boolean" ? su.restoreSession : true,
    },
    files: {
      deleteMode: oneOf<DeleteModePref>(
        fi.deleteMode,
        DELETE_MODES,
        DEFAULT_PREFS.files.deleteMode,
      ),
    },
    updates: {
      autoUpdate: typeof up.autoUpdate === "boolean" ? up.autoUpdate : true,
      channel: oneOf<UpdateChannelPref>(up.channel, ["stable", "beta"], "stable"),
    },
    debug: {
      enabled: typeof dbg.enabled === "boolean" ? dbg.enabled : DEFAULT_DEBUG_PREFS.enabled,
      logLevel: oneOf<LogLevelPref>(
        dbg.logLevel,
        ["debug", "info", "warn", "error"],
        DEFAULT_DEBUG_PREFS.logLevel,
      ),
      logToFile: typeof dbg.logToFile === "boolean" ? dbg.logToFile : DEFAULT_DEBUG_PREFS.logToFile,
    },
    docks: {
      leftPinned: typeof dk.leftPinned === "boolean" ? dk.leftPinned : true,
      rightPinned: typeof dk.rightPinned === "boolean" ? dk.rightPinned : true,
      rightEnabled: typeof dk.rightEnabled === "boolean" ? dk.rightEnabled : true,
    },
    window: {
      width: boundedNumber(wi.width, 640, 8192, DEFAULT_PREFS.window.width),
      height: boundedNumber(wi.height, 420, 8192, DEFAULT_PREFS.window.height),
      leftPanelWidth: boundedNumber(
        wi.leftPanelWidth,
        PANEL_WIDTH_MIN,
        PANEL_WIDTH_MAX,
        DEFAULT_PREFS.window.leftPanelWidth,
      ),
      rightPanelWidth: boundedNumber(
        wi.rightPanelWidth,
        PANEL_WIDTH_MIN,
        PANEL_WIDTH_MAX,
        DEFAULT_PREFS.window.rightPanelWidth,
      ),
      maximized: typeof wi.maximized === "boolean" ? wi.maximized : false,
    },
    shortcuts: normalizeShortcutBindings(d.shortcuts),
  }
}

export interface GlobalSettings {
  schemaVersion: number
  panelScope: PanelScope
  defaultTheme: string | null
  /** Used when panelScope === "global". */
  layout: LayoutConfig
  /** Retained for backwards-compatible settings reads; released modules do not depend on it. */
  experimental: ExperimentalSettings
  ai: AiSettings
  prefs: AppPreferences
  /** Globally installed user themes. Only validated portable JSON is persisted. */
  themes: ThemeDefinition[]
}

export interface ExperimentalSettings {
  /** Legacy field retained so older settings remain readable and writable. */
  databasesV1: boolean
}

export const DEFAULT_EXPERIMENTAL: ExperimentalSettings = {
  databasesV1: false,
}

function normalizeExperimental(raw: unknown): ExperimentalSettings {
  const d = (raw ?? {}) as Partial<ExperimentalSettings>
  return {
    databasesV1: d.databasesV1 === true,
  }
}

export async function migrateLegacyAiKeys(
  rawAi: unknown,
): Promise<{ ai: AiSettings; migrated: boolean }> {
  if (!rawAi || typeof rawAi !== "object") {
    return { ai: DEFAULT_AI, migrated: false }
  }
  const d = rawAi as { version?: unknown; models?: unknown[]; activeModelId?: unknown }
  // The legacy reader cannot safely rewrite any versioned AI section.
  if (Object.prototype.hasOwnProperty.call(d, "version")) throw new Error("unsupportedAiVersion")
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
      supportsTools: typeof m.supportsTools === "boolean" ? m.supportsTools : undefined,
    })
  }
  if (models.length === 0) {
    return { ai: { models: [], activeModelId: null }, migrated }
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
      experimental: DEFAULT_EXPERIMENTAL,
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
  const versioned =
    !!d.ai && typeof d.ai === "object" && Object.prototype.hasOwnProperty.call(d.ai, "version")
  const { ai, migrated } = versioned
    ? { ai: projectAiConnections(readAiConnections(d.ai)), migrated: false }
    : await migrateLegacyAiKeys(d.ai)
  const settings: GlobalSettings = {
    ...d,
    schemaVersion: typeof d.schemaVersion === "number" ? d.schemaVersion : SETTINGS_SCHEMA_VERSION,
    panelScope: d.panelScope === "workspace" ? "workspace" : "global",
    defaultTheme: legacyTheme,
    layout: { ...EMPTY_LAYOUT, ...(d.layout ?? {}) },
    experimental: normalizeExperimental(d.experimental),
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
  return (
    ai.models.find((m) => m.id === ai.activeModelId) ??
    (ai.connectionSettings ? null : ai.models[0]) ??
    null
  )
}

/** Resolve a model entry to the flat `AiConfig` the `aiChat` command expects,
 *  filling provider defaults for any blank connection fields. */
export function resolveAiConfig(model: AiModel): AiConfig {
  const p = findProvider(model.provider)
  const family: AiFamily = p?.family ?? "ollama"
  return {
    provider: family,
    internalModelId: model.id,
    model: model.model || p?.defaultModel || "",
    baseUrl: model.baseUrl || p?.defaultBaseUrl || "",
    credentialId: model.credentialId || null,
    // A local model that thinks first spends part of the limit on thinking; at 1024 it can run
    // out before it writes the answer, which then arrives empty.
    maxTokens: isLocalAiModel(model) ? 4096 : 1024,
    apiVersion: family === "azure" ? model.apiVersion || "2024-06-01" : null,
  }
}

export function saveSettingsPatch(
  patch: Partial<GlobalSettings>,
  options?: { expectedAi?: AiSettings["connectionSettings"] },
): Promise<void> {
  const write = async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const before = await readGlobalRaw(SETTINGS_FILE)
      const cur = await loadSettings()
      if ((await readGlobalRaw(SETTINGS_FILE)) !== before) continue
      if (cur.ai.connectionSettings && patch.ai && !patch.ai.connectionSettings) {
        throw new Error("unsupportedAiVersion")
      }
      if (patch.ai?.connectionSettings) {
        const expected = options?.expectedAi ?? patch.ai.connectionSettings
        if (JSON.stringify(cur.ai.connectionSettings) !== JSON.stringify(expected))
          throw new Error("settingsChanged")
      }
      const next = {
        ...cur,
        ...patch,
        ai: serializeAiSettings(patch.ai ?? cur.ai),
        schemaVersion: SETTINGS_SCHEMA_VERSION,
      }
      if (await compareWriteGlobalRaw(SETTINGS_FILE, before, JSON.stringify(next, null, 2))) {
        if (patch.ai && typeof window !== "undefined")
          window.dispatchEvent(new Event(AI_SETTINGS_CHANGED_EVENT))
        return
      }
    }
    throw new Error("settingsChanged")
  }
  const next = settingsWriteChain.then(write, write)
  settingsWriteChain = next.catch((err) => {
    // A caller that passes the settings it built on handles a conflict itself (it reloads and
    // repeats the change), so the generic save error would only be noise.
    if (options?.expectedAi && (err as Error)?.message === "settingsChanged") return
    emitSettingsSaveError(SETTINGS_FILE, err)
  })
  return next
}

/** Start the durable migration only when the connection screen is opened. */
export async function loadAiConnectionSettings(): Promise<GlobalSettings> {
  if (!isTauri()) return loadSettings()
  let raw = await readGlobalRaw(SETTINGS_FILE)
  if (raw === null) {
    await saveSettingsPatch({})
    raw = await readGlobalRaw(SETTINGS_FILE)
  }
  if (raw === null) throw new Error("settingsUnavailable")
  let value: unknown
  try {
    value = JSON.parse(raw.replace(/^\uFEFF/, ""))
  } catch {
    throw new Error("corruptSettings")
  }
  const ai = value && typeof value === "object" ? (value as { ai?: unknown }).ai : undefined
  if (
    !ai ||
    typeof ai !== "object" ||
    !Object.prototype.hasOwnProperty.call(ai, "version") ||
    (ai as { version?: unknown }).version === 1
  ) {
    await migrateAiSettings()
    if (typeof window !== "undefined") window.dispatchEvent(new Event(AI_SETTINGS_CHANGED_EVENT))
  }
  return loadSettings()
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
  profile?: WorkspaceProfileState
  enabledModules?: string[]
  moduleSettings?: Record<string, unknown>
}

let pendingWorkspaceProfile: ProfileId | null = null

export function setPendingWorkspaceProfile(profile: ProfileId | null): void {
  pendingWorkspaceProfile = profile
}

export function getPendingWorkspaceProfile(): ProfileId | null {
  return pendingWorkspaceProfile
}

export async function loadWorkspaceConfig(): Promise<WorkspaceConfig> {
  if (await vaultFileMissing(WORKSPACE_FILE)) {
    // Custom presets were a single global list pre-tier; each vault inherits a copy.
    const customPresets = parseLS<Preset[]>("amby:user-presets:v1", Array.isArray) ?? []
    const requestedProfile = pendingWorkspaceProfile
    pendingWorkspaceProfile = null

    const baseConfig = requestedProfile
      ? applyProfileToWorkspace(requestedProfile)
      : (await migrateWorkspaceModules({ layout: EMPTY_LAYOUT })).config

    const layout: LayoutConfig = {
      ...EMPTY_LAYOUT,
      activePresetId: baseConfig.profile.id === "minimal" ? "simple" : "standard",
      activeModules: baseConfig.enabledModules,
    }

    const cfg: WorkspaceConfig = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      theme: null,
      customPresets,
      layout,
      confirmations: { confirmFileDelete: true },
      profile: baseConfig.profile,
      enabledModules: baseConfig.enabledModules,
      moduleSettings: baseConfig.moduleSettings,
    }
    await saveVaultJSON(WORKSPACE_FILE, cfg)
    return cfg
  }
  const d = await loadVaultJSON<Partial<WorkspaceConfig>>(WORKSPACE_FILE, {})
  const { config, migrated } = await migrateWorkspaceModules(d as Record<string, unknown>)
  const result: WorkspaceConfig = {
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
    profile: config.profile,
    enabledModules: config.enabledModules,
    moduleSettings: config.moduleSettings,
  }
  if (migrated) {
    try {
      await saveVaultJSON(WORKSPACE_FILE, result)
    } catch (err) {
      console.warn("Failed to persist migrated workspace config:", err)
    }
  }
  return result
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

/**
 * Records which preset runs and with which modules in the vault's own file, beside its list of
 * presets. The settings window reads the active preset from there, so what the app runs and what
 * the settings show cannot drift apart. The rest of the layout is left as it is.
 */
export function saveWorkspaceActivePreset(
  activePresetId: string,
  activeModules: string[],
): Promise<void> {
  const write = async () => {
    const cur = await loadWorkspaceConfig()
    await saveVaultJSON(WORKSPACE_FILE, {
      ...cur,
      enabledModules: activeModules,
      layout: { ...cur.layout, activePresetId, activeModules },
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
  /** Per-page primary layer chosen by the user. */
  primaryLayers?: Record<string, string>
  /** Per-page content width overrides; database pages use database:<id> keys. */
  contentWidths?: Record<string, string>
  /** Custom title-column labels for database pages, keyed by database:<id>. */
  databaseTitleLabels?: Record<string, string>
  nestedNotesPlacements: Record<string, string>
  locked: string[]
  icons: Record<string, string>
  /** Optional for sessions saved before tree expansion was persisted. */
  closedTreeIds?: string[]
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
      primaryLayers: {},
      contentWidths: {},
      databaseTitleLabels: {},
      nestedNotesPlacements: {},
      locked: parseLS<string[]>(`amby:locked:${vaultPath}`, Array.isArray) ?? [],
      icons: parseLS<Record<string, string>>("amby:icons", isRecord) ?? {},
    }
    const hasAny =
      session.tabs.length ||
      session.favorites.length ||
      session.locked.length ||
      Object.keys(session.viewModes).length ||
      Object.keys(session.contentWidths ?? {}).length ||
      Object.keys(session.databaseTitleLabels ?? {}).length ||
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
    primaryLayers: isRecord(d.primaryLayers) ? d.primaryLayers : {},
    contentWidths: isRecord(d.contentWidths) ? d.contentWidths : {},
    databaseTitleLabels: isRecord(d.databaseTitleLabels) ? d.databaseTitleLabels : {},
    nestedNotesPlacements: isRecord(d.nestedNotesPlacements) ? d.nestedNotesPlacements : {},
    locked: Array.isArray(d.locked) ? d.locked : [],
    icons: isRecord(d.icons) ? d.icons : {},
    closedTreeIds: Array.isArray(d.closedTreeIds)
      ? d.closedTreeIds.filter((id): id is string => typeof id === "string")
      : [],
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
