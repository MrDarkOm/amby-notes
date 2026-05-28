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

export const WORKSPACES_FILE = "workspaces.json"
export const SETTINGS_FILE = "settings.json"
export const WORKSPACE_FILE = "workspace.json"
export const SESSION_FILE = "session.json"

export type PanelScope = "global" | "workspace"

/** The activity-bar arrangement that the panelScope toggle routes global ⟷ vault. */
export interface LayoutConfig {
  activePresetId: string | null
  buttons: ActivityButton[] | null
  activeBySide: Record<Side, PanelId | null> | null
}

const EMPTY_LAYOUT: LayoutConfig = { activePresetId: null, buttons: null, activeBySide: null }

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

export interface GlobalSettings {
  panelScope: PanelScope
  defaultTheme: string | null
  /** Used when panelScope === "global". */
  layout: LayoutConfig
}

export async function loadSettings(): Promise<GlobalSettings> {
  if (await globalFileMissing(SETTINGS_FILE)) {
    const layout: LayoutConfig = {
      activePresetId: readLS("amby:active-preset:v1"),
      buttons: parseLS<ActivityButton[]>("amby:panel-buttons:v1", Array.isArray),
      activeBySide: parseLS<Record<Side, PanelId | null>>(
        "amby:active-views:v1",
        (v): v is Record<Side, PanelId | null> => !!v && typeof v === "object",
      ),
    }
    const settings: GlobalSettings = { panelScope: "global", defaultTheme: null, layout }
    if (layout.activePresetId || layout.buttons || layout.activeBySide) {
      await saveGlobalJSON(SETTINGS_FILE, settings)
    }
    return settings
  }
  const d = await loadGlobalJSON<Partial<GlobalSettings>>(SETTINGS_FILE, {})
  return {
    panelScope: d.panelScope === "workspace" ? "workspace" : "global",
    defaultTheme: typeof d.defaultTheme === "string" ? d.defaultTheme : null,
    layout: { ...EMPTY_LAYOUT, ...(d.layout ?? {}) },
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
