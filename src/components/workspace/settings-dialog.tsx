"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { LogicalPosition } from "@tauri-apps/api/dpi"
import { emitTo, listen } from "@tauri-apps/api/event"
import { WebviewWindow } from "@tauri-apps/api/webviewWindow"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { adoptAsyncDisposer } from "@/lib/async-disposable"
import { motion } from "motion/react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Blocks,
  Bot,
  Check,
  ChevronRight,
  Clock3,
  Cloud,
  Database,
  Download,
  ExternalLink,
  FolderOpen,
  GitBranch,
  Minus,
  Monitor,
  Keyboard,
  Loader2,
  Palette,
  PencilLine,
  RotateCcw,
  Search,
  Sparkles,
  Star,
  Tags,
  Trash2,
  Type,
  Upload,
  UserRound,
  X,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { motionTransitions } from "@/lib/motion-config"
import { MotionSpinner } from "@/lib/motion"
import {
  checkForAppUpdate,
  getCurrentAppVersion,
  isAppUpdaterAvailable,
  type AvailableAppUpdate,
  type UpdateInstallProgress,
} from "@/lib/app-updater"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  confirmAction,
  exportTextFile,
  importTextFile,
  openInExplorer,
  isTauri,
} from "@/lib/storage"
import {
  BUILTIN_THEME_FAMILIES,
  BUILTIN_THEMES,
  builtinThemeFamilyForId,
  parseThemeDefinition,
  themeById,
  withUniqueThemeId,
  type BuiltinTheme,
  type ThemeDefinition,
  type ThemeModePreference,
  ACCENT_HEX,
} from "@/lib/themes"
import { SUPPORTED_LANGUAGES } from "@/lib/i18n"
import { useSettingsStore } from "./use-settings-store"
import { useVaultStore } from "./use-vault-store"
import {
  isSettingsModuleId,
  isSettingsSectionId,
  type SettingsNavigationTarget,
  type SettingsSectionId,
} from "./settings-navigation"
import { ModelsManager } from "./models-manager"
import { isModuleAvailable, MODULE_REGISTRY } from "./modules"
import {
  ACCENTS,
  DEFAULT_AI,
  DEFAULT_PREFS,
  loadSettings,
  loadWorkspaceConfig,
  saveSettingsPatch,
  saveWorkspaceConfigPatch,
  saveWorkspaces,
  SETTINGS_SAVE_ERROR_EVENT,
  WORKSPACES_SCHEMA_VERSION,
  type AiSettings,
  type ContentWidth,
  type Density,
  type FontScale,
  type FontFamily,
  type Language,
  type ThemePref,
  type ViewModePref,
} from "./app-config"
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_DEFINITIONS,
  formatShortcut,
  shortcutFromEvent,
  type ShortcutActionId,
} from "./keyboard-shortcuts"

function Row({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="settings-row flex items-center justify-between gap-4 px-4">
      <div className="min-w-0">
        <div className="text-[13px] text-foreground">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

const selectTrigger = "h-8 w-44 bg-card border-border text-[13px] text-foreground"
const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)
const SETTINGS_WINDOW_LABEL = "settings"
const SETTINGS_MODULE_CHANGE_EVENT = "amby:settings-module-change"
const SETTINGS_CONTEXT_CHANGE_EVENT = "amby:settings-context-change"

interface ModuleChangePayload {
  id: string
  enabled: boolean
}

interface SettingsContextPayload {
  activeModules: string[]
  vault: string | null
  target?: SettingsNavigationTarget
}

function settingsWindowUrl(
  activeModules: string[],
  vault: string | null,
  target: SettingsNavigationTarget | null,
): string {
  const params = new URLSearchParams({
    ambyView: "settings",
    activeModules: JSON.stringify(activeModules),
  })
  if (vault) params.set("vault", vault)
  if (target) {
    params.set("settingsSection", target.section)
    if (target.moduleId) params.set("settingsModule", target.moduleId)
  }
  return `/?${params.toString()}`
}

async function openSettingsWindow(
  activeModules: string[],
  title: string,
  vault: string | null,
  target: SettingsNavigationTarget | null,
): Promise<void> {
  const existing = await WebviewWindow.getByLabel(SETTINGS_WINDOW_LABEL)
  if (existing) {
    await existing.unminimize()
    await existing.show()
    await existing.setFocus()
    await emitTo<SettingsContextPayload>(SETTINGS_WINDOW_LABEL, SETTINGS_CONTEXT_CHANGE_EVENT, {
      activeModules,
      vault,
      target: target ?? undefined,
    }).catch(() => {})
    return
  }

  const child = new WebviewWindow(SETTINGS_WINDOW_LABEL, {
    url: settingsWindowUrl(activeModules, vault, target),
    title,
    width: 1024,
    height: 720,
    minWidth: 680,
    minHeight: 480,
    center: true,
    focus: true,
    resizable: true,
    maximizable: true,
    minimizable: true,
    closable: true,
    decorations: isMac,
    titleBarStyle: isMac ? "overlay" : undefined,
    hiddenTitle: isMac,
    trafficLightPosition: isMac ? new LogicalPosition(14, 22) : undefined,
  })
  void child.once("tauri://error", (event) => {
    console.error("Failed to open settings window:", event.payload)
  })
}

const SETTINGS_NAV = [
  { id: "general", labelKey: "settings.tabs.general", icon: UserRound },
  { id: "appearance", labelKey: "settings.tabs.appearance", icon: Palette },
  { id: "interface", labelKey: "settings.tabs.interface", icon: Monitor },
  { id: "editor", labelKey: "settings.tabs.editor", icon: PencilLine },
  { id: "shortcuts", labelKey: "settings.tabs.shortcuts", icon: Keyboard },
  { id: "modules", labelKey: "settings.tabs.modules", icon: Blocks },
] as const

interface SettingsDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  standalone?: boolean
  vault: string | null
  navigationTarget?: SettingsNavigationTarget | null
  activeModules: string[]
  onModuleEnabledChange: (id: string, enabled: boolean) => void
}

function SettingsWindowFrame({
  standalone,
  open,
  onOpenChange,
  maximized,
  searchInputRef,
  children,
}: {
  standalone: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  maximized: boolean
  searchInputRef: React.RefObject<HTMLInputElement | null>
  children: React.ReactNode
}) {
  if (standalone) {
    return (
      <div className="flex h-screen w-screen min-w-0 flex-col overflow-hidden bg-background">
        {children}
      </div>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          searchInputRef.current?.focus()
        }}
        className="flex max-w-none flex-col gap-0 overflow-hidden rounded-xl border-border bg-background p-0 shadow-2xl sm:max-w-none"
        style={{
          width: maximized ? "calc(100vw - 16px)" : "min(1024px, calc(100vw - 32px))",
          height: maximized ? "calc(100vh - 16px)" : "min(720px, calc(100vh - 32px))",
          minWidth: "min(680px, calc(100vw - 32px))",
          minHeight: "min(480px, calc(100vh - 32px))",
          maxWidth: "calc(100vw - 16px)",
          maxHeight: "calc(100vh - 16px)",
          resize: maximized ? "none" : "both",
        }}
      >
        {children}
      </DialogContent>
    </Dialog>
  )
}

export function SettingsDialog({
  open,
  onOpenChange,
  standalone = false,
  vault,
  navigationTarget = null,
  activeModules,
  onModuleEnabledChange,
}: SettingsDialogProps) {
  const { t } = useTranslation()
  const prefs = useSettingsStore((s) => s.prefs)
  const themes = useSettingsStore((s) => s.themes)
  const setPrefs = useSettingsStore((s) => s.setPrefs)
  const setThemes = useSettingsStore((s) => s.setThemes)
  const searchInputRef = React.useRef<HTMLInputElement>(null)
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const [activeSection, setActiveSection] = React.useState<SettingsSectionId>("general")
  const [selectedModuleId, setSelectedModuleId] = React.useState(MODULE_REGISTRY[0]?.id ?? "")
  const [query, setQuery] = React.useState("")
  const [maximized, setMaximized] = React.useState(false)

  React.useEffect(() => {
    if (!navigationTarget) return
    setActiveSection(navigationTarget.section)
    if (navigationTarget.moduleId) setSelectedModuleId(navigationTarget.moduleId)
    setQuery("")
  }, [navigationTarget])

  React.useEffect(() => {
    const onSaveError = (event: Event) => {
      const message = (event as CustomEvent<{ message?: unknown }>).detail?.message
      if (typeof message === "string") setSaveError(message)
    }
    window.addEventListener(SETTINGS_SAVE_ERROR_EVENT, onSaveError)
    return () => window.removeEventListener(SETTINGS_SAVE_ERROR_EVENT, onSaveError)
  }, [])

  React.useEffect(() => {
    if (!open) {
      setQuery("")
      setMaximized(false)
    }
  }, [open])

  const searchResults = React.useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return []
    const entries: Array<{
      section: SettingsSectionId
      label: string
      description: string
      targetId?: string
    }> = [
      {
        section: "general",
        label: t("settings.groups.startup"),
        description: `${t("settings.startup.reopenLastVault")} · ${t("settings.startup.restoreSession")}`,
      },
      {
        section: "general",
        label: t("settings.groups.updates"),
        description: `${t("settings.updates.autoUpdate")} · ${t("settings.updates.check")} · ${t("settings.updates.currentVersion")}`,
      },
      {
        section: "general",
        label: t("settings.groups.workspace"),
        description: `${t("settings.appearance.language")} · ${t("settings.general.confirmFileDelete")}`,
      },
      {
        section: "general",
        label: t("settings.groups.data"),
        description: `${t("settings.data.location")} · ${t("settings.data.reset")}`,
      },
      {
        section: "appearance",
        label: t("settings.appearance.themeLibrary"),
        description: `${t("settings.appearance.theme")} · ${t("settings.appearance.themeMode")} · ${t("settings.appearance.importTheme")} · ${t("settings.appearance.accent")}`,
      },
      {
        section: "interface",
        label: t("settings.groups.interface"),
        description: `${t("settings.appearance.density")} · ${t("settings.interface.tooltipDelay")}`,
      },
      {
        section: "editor",
        label: t("settings.tabs.editor"),
        description: `${t("settings.editor.defaultViewMode")} · ${t("settings.editor.contentWidth")} · ${t("settings.editor.autosave")}`,
      },
      {
        section: "shortcuts",
        label: t("settings.tabs.shortcuts"),
        description: SHORTCUT_DEFINITIONS.map(({ labelKey }) => t(labelKey)).join(" · "),
      },
      ...MODULE_REGISTRY.map((module) => ({
        section: "modules" as const,
        label: t(module.labelKey),
        description: t(module.descriptionKey),
        targetId: module.id,
      })),
    ]
    return entries.filter(({ label, description }) =>
      `${label} ${description}`.toLocaleLowerCase().includes(normalized),
    )
  }, [query, t])

  React.useEffect(() => {
    if (standalone || !isTauri()) return
    return adoptAsyncDisposer(
      listen<ModuleChangePayload>(SETTINGS_MODULE_CHANGE_EVENT, (event) => {
        onModuleEnabledChange(event.payload.id, event.payload.enabled)
      }),
    )
  }, [onModuleEnabledChange, standalone])

  React.useEffect(() => {
    if (standalone || !isTauri()) return
    void emitTo<SettingsContextPayload>(SETTINGS_WINDOW_LABEL, SETTINGS_CONTEXT_CHANGE_EVENT, {
      activeModules,
      vault,
    }).catch(() => {})
  }, [activeModules, standalone, vault])

  React.useEffect(() => {
    if (!open || standalone || !isTauri()) return
    void openSettingsWindow(
      activeModules,
      t("settings.window.title"),
      vault,
      navigationTarget,
    ).finally(() => onOpenChange(false))
  }, [activeModules, navigationTarget, onOpenChange, open, standalone, t, vault])

  React.useEffect(() => {
    if (!standalone || !open) return
    searchInputRef.current?.focus()
  }, [open, standalone])

  if (!standalone && isTauri()) return null

  return (
    <SettingsWindowFrame
      standalone={standalone}
      open={open}
      onOpenChange={onOpenChange}
      maximized={maximized}
      searchInputRef={searchInputRef}
    >
      <SettingsWindowHeader
        native={standalone && isTauri()}
        maximized={maximized}
        onMinimize={() => {
          if (standalone && isTauri()) void getCurrentWindow().minimize()
          else onOpenChange(false)
        }}
        onToggleMaximize={() => {
          if (standalone && isTauri()) void getCurrentWindow().toggleMaximize()
          setMaximized((value) => !value)
        }}
        onClose={() => {
          if (standalone && isTauri()) void getCurrentWindow().close()
          else onOpenChange(false)
        }}
      />

      <Tabs
        value={activeSection}
        onValueChange={(value) => setActiveSection(value as SettingsSectionId)}
        className="min-h-0 flex-1 flex-row gap-0 bg-background"
      >
        <TabsList className="h-auto w-14 shrink-0 flex-col items-stretch justify-start gap-1 rounded-none bg-transparent p-2 sm:w-60 sm:p-3">
          <div className="relative mb-2 hidden w-full sm:block">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("settings.search.placeholder")}
              aria-label={t("settings.search.placeholder")}
              className="h-8 bg-card pl-8 text-[12px]"
            />
          </div>
          {saveError && (
            <p role="alert" className="mb-2 hidden px-2 text-[11px] text-destructive sm:block">
              {saveError}
            </p>
          )}
          {SETTINGS_NAV.map(({ id, labelKey, icon: Icon }) => (
            <TabsTrigger
              key={id}
              value={id}
              title={t(labelKey)}
              className="h-10 w-full flex-none justify-center rounded-lg px-0 text-left sm:justify-start sm:px-3 data-[state=active]:bg-card data-[state=active]:shadow-sm"
            >
              <Icon className="size-4 shrink-0" />
              <span className="hidden truncate sm:inline">{t(labelKey)}</span>
            </TabsTrigger>
          ))}
        </TabsList>

        <div
          className={cn(
            "m-3 ml-0 min-w-0 flex-1 overflow-y-auto rounded-xl border border-border bg-card shadow-sm",
            activeSection === "modules" && !query.trim() ? "p-0" : "px-4 py-5 sm:px-7",
          )}
        >
          {query.trim() ? (
            <SearchResults
              query={query}
              results={searchResults}
              onOpen={(section, targetId) => {
                setActiveSection(section)
                if (targetId) setSelectedModuleId(targetId)
                setQuery("")
              }}
            />
          ) : (
            <>
              {/* ── General ──────────────────────────────────────────────── */}
              <TabsContent value="general" className="space-y-6">
                <SettingsGroup title={t("settings.groups.workspace")} icon={Monitor}>
                  <Row label={t("settings.appearance.language")}>
                    <Select
                      value={prefs.language}
                      onValueChange={(v) => setPrefs({ language: v as Language })}
                    >
                      <SelectTrigger className={selectTrigger}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SUPPORTED_LANGUAGES.map((language) => (
                          <SelectItem key={language.code} value={language.code}>
                            {t(language.labelKey)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Row>
                  <DeleteConfirmationSetting vault={vault} />
                </SettingsGroup>
                <SettingsGroup title={t("settings.groups.startup")} icon={Sparkles}>
                  <Row label={t("settings.startup.reopenLastVault")}>
                    <Switch
                      checked={prefs.startup.reopenLastVault}
                      onCheckedChange={(c) =>
                        setPrefs({ startup: { ...prefs.startup, reopenLastVault: c } })
                      }
                    />
                  </Row>
                  <Row label={t("settings.startup.restoreSession")}>
                    <Switch
                      checked={prefs.startup.restoreSession}
                      onCheckedChange={(c) =>
                        setPrefs({ startup: { ...prefs.startup, restoreSession: c } })
                      }
                    />
                  </Row>
                </SettingsGroup>
                <SettingsGroup title={t("settings.groups.updates")} icon={Download}>
                  <UpdateSettings />
                </SettingsGroup>
                <SettingsGroup title={t("settings.groups.data")} icon={FolderOpen}>
                  <DataTab vault={vault} />
                </SettingsGroup>
              </TabsContent>

              {/* ── Appearance ───────────────────────────────────────────── */}
              <TabsContent value="appearance" className="space-y-6">
                <SettingsGroup title={t("settings.appearance.themeLibrary")} icon={Palette}>
                  <ThemeLibrary
                    selectedThemeId={prefs.theme}
                    themes={themes}
                    onSelect={(theme: ThemePref) => setPrefs({ theme })}
                    onThemesChange={setThemes}
                  />
                </SettingsGroup>
                <SettingsGroup title={t("settings.groups.colorsEffects")} icon={Palette}>
                  <Row label={t("settings.appearance.accent")}>
                    <div className="flex items-center gap-1.5">
                      {ACCENTS.map((a) => (
                        <motion.button
                          key={a}
                          type="button"
                          title={a}
                          aria-pressed={prefs.accent === a}
                          onClick={() => setPrefs({ accent: a })}
                          style={{ background: ACCENT_HEX[a] }}
                          className={cn(
                            "flex size-6 items-center justify-center rounded-full ring-2 ring-offset-2 ring-offset-background",
                            prefs.accent === a
                              ? "ring-foreground/80"
                              : "ring-transparent hover:ring-foreground/30",
                          )}
                          initial={false}
                          animate={{ scale: prefs.accent === a ? 1.08 : 1 }}
                          whileTap={{ scale: 0.94 }}
                          transition={motionTransitions.default}
                        >
                          {prefs.accent === a && <Check className="size-3.5 text-white" />}
                        </motion.button>
                      ))}
                    </div>
                  </Row>
                  <Row
                    label={t("settings.appearance.rainbowTree")}
                    hint={t("settings.appearance.rainbowTreeHint")}
                  >
                    <Switch
                      checked={prefs.rainbowTree}
                      onCheckedChange={(rainbowTree) => setPrefs({ rainbowTree })}
                    />
                  </Row>
                </SettingsGroup>
                <SettingsGroup title={t("settings.groups.typography")} icon={Type}>
                  <Row label={t("settings.appearance.fontFamily")}>
                    <Select
                      value={prefs.fontFamily}
                      onValueChange={(fontFamily) =>
                        setPrefs({ fontFamily: fontFamily as FontFamily })
                      }
                    >
                      <SelectTrigger className={selectTrigger}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="system">
                          {t("settings.appearance.fontSystem")}
                        </SelectItem>
                        <SelectItem value="sans">{t("settings.appearance.fontSans")}</SelectItem>
                        <SelectItem value="serif">{t("settings.appearance.fontSerif")}</SelectItem>
                        <SelectItem value="mono">{t("settings.appearance.fontMono")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </Row>
                  <Row label={t("settings.appearance.fontScale")}>
                    <Select
                      value={prefs.fontScale}
                      onValueChange={(v) => setPrefs({ fontScale: v as FontScale })}
                    >
                      <SelectTrigger className={selectTrigger}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="sm">{t("settings.appearance.fontSm")}</SelectItem>
                        <SelectItem value="md">{t("settings.appearance.fontMd")}</SelectItem>
                        <SelectItem value="lg">{t("settings.appearance.fontLg")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </Row>
                </SettingsGroup>
              </TabsContent>

              {/* ── Interface ────────────────────────────────────────────── */}
              <TabsContent value="interface" className="space-y-6">
                <SettingsGroup title={t("settings.groups.interface")} icon={Monitor}>
                  <Row label={t("settings.appearance.density")}>
                    <Select
                      value={prefs.density}
                      onValueChange={(v) => setPrefs({ density: v as Density })}
                    >
                      <SelectTrigger className={selectTrigger}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="comfortable">
                          {t("settings.appearance.comfortable")}
                        </SelectItem>
                        <SelectItem value="compact">{t("settings.appearance.compact")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </Row>
                  <Row label={t("settings.interface.tooltipDelay")}>
                    <Select
                      value={String(prefs.tooltipDelayMs)}
                      onValueChange={(value) => {
                        const next = Number(value)
                        setPrefs({ tooltipDelayMs: next })
                      }}
                    >
                      <SelectTrigger className={selectTrigger}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="0">{t("settings.interface.tooltipNone")}</SelectItem>
                        <SelectItem value="1000">
                          {t("settings.interface.tooltipOneSecond")}
                        </SelectItem>
                        <SelectItem value="1500">
                          {t("settings.interface.tooltipOneHalfSeconds")}
                        </SelectItem>
                        <SelectItem value="2000">
                          {t("settings.interface.tooltipTwoSeconds")}
                        </SelectItem>
                        <SelectItem value="-1">
                          {t("settings.interface.tooltipDisabled")}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </Row>
                </SettingsGroup>
              </TabsContent>

              {/* ── Editor ───────────────────────────────────────────────── */}
              <TabsContent value="editor" className="space-y-6">
                <SettingsGroup title={t("settings.groups.editing")} icon={PencilLine}>
                  <Row label={t("settings.editor.defaultViewMode")}>
                    <Select
                      value={prefs.editor.defaultViewMode}
                      onValueChange={(v) =>
                        setPrefs({
                          editor: { ...prefs.editor, defaultViewMode: v as ViewModePref },
                        })
                      }
                    >
                      <SelectTrigger className={selectTrigger}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="live">{t("settings.editor.live")}</SelectItem>
                        <SelectItem value="source">{t("settings.editor.source")}</SelectItem>
                        <SelectItem value="read">{t("settings.editor.read")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </Row>

                  <Row label={t("settings.editor.contentWidth")}>
                    <Select
                      value={prefs.editor.contentWidth}
                      onValueChange={(v) =>
                        setPrefs({ editor: { ...prefs.editor, contentWidth: v as ContentWidth } })
                      }
                    >
                      <SelectTrigger className={selectTrigger}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="normal">{t("settings.editor.normal")}</SelectItem>
                        <SelectItem value="wide">{t("settings.editor.wide")}</SelectItem>
                        <SelectItem value="full">{t("settings.editor.full")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </Row>

                  <Row
                    label={t("settings.editor.autosave")}
                    hint={t("settings.editor.autosaveHint")}
                  >
                    <input
                      type="number"
                      min={200}
                      max={10000}
                      step={100}
                      value={prefs.editor.autosaveMs}
                      onChange={(e) => {
                        const n = Number(e.target.value)
                        if (Number.isFinite(n))
                          setPrefs({ editor: { ...prefs.editor, autosaveMs: n } })
                      }}
                      className="h-8 w-24 rounded-md border border-border bg-card px-2 text-right text-[13px] text-foreground outline-none focus:border-border"
                    />
                  </Row>
                </SettingsGroup>
              </TabsContent>

              {/* ── Keyboard shortcuts ─────────────────────────────────── */}
              <TabsContent value="shortcuts" className="space-y-6">
                <ShortcutsTab />
              </TabsContent>

              <TabsContent value="modules">
                <ModulesTab
                  activeModules={activeModules}
                  onModuleEnabledChange={onModuleEnabledChange}
                  selectedId={selectedModuleId}
                  onSelectedChange={setSelectedModuleId}
                />
              </TabsContent>
            </>
          )}
        </div>
      </Tabs>
    </SettingsWindowFrame>
  )
}

type UpdateUiState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "current" }
  | { phase: "available"; version: string }
  | { phase: "downloading"; percent: number | null }
  | { phase: "installing" | "restarting" }
  | { phase: "error" }

function UpdateSettings() {
  const { t } = useTranslation()
  const prefs = useSettingsStore((state) => state.prefs)
  const setPrefs = useSettingsStore((state) => state.setPrefs)
  const supported = isAppUpdaterAvailable()
  const [version, setVersion] = React.useState("…")
  const [update, setUpdate] = React.useState<AvailableAppUpdate | null>(null)
  const [state, setState] = React.useState<UpdateUiState>({ phase: "idle" })

  React.useEffect(() => {
    void getCurrentAppVersion().then(setVersion)
  }, [])

  React.useEffect(() => {
    return () => {
      void update?.close().catch(() => {})
    }
  }, [update])

  const checkNow = async () => {
    setState({ phase: "checking" })
    try {
      const next = await checkForAppUpdate()
      setUpdate(next)
      setState(next ? { phase: "available", version: next.version } : { phase: "current" })
    } catch {
      setUpdate(null)
      setState({ phase: "error" })
    }
  }

  const install = async () => {
    if (!update) return
    const onProgress = (progress: UpdateInstallProgress) => setState(progress)
    try {
      await update.install(onProgress)
    } catch {
      setState({ phase: "error" })
    }
  }

  const status = !supported
    ? t("settings.updates.installedOnly")
    : state.phase === "checking"
      ? t("settings.updates.checking")
      : state.phase === "current"
        ? t("settings.updates.current")
        : state.phase === "available"
          ? t("settings.updates.available", { version: state.version })
          : state.phase === "downloading"
            ? state.percent === null
              ? t("settings.updates.downloading")
              : t("settings.updates.downloadingProgress", { progress: state.percent })
            : state.phase === "installing"
              ? t("settings.updates.installing")
              : state.phase === "restarting"
                ? t("settings.updates.restarting")
                : state.phase === "error"
                  ? t("settings.updates.error")
                  : t("settings.updates.checkHint")
  const busy = ["checking", "downloading", "installing", "restarting"].includes(state.phase)

  return (
    <>
      <Row label={t("settings.updates.autoUpdate")} hint={t("settings.updates.autoUpdateHint")}>
        <Switch
          checked={prefs.updates.autoUpdate}
          onCheckedChange={(autoUpdate) => setPrefs({ updates: { autoUpdate } })}
        />
      </Row>
      <Row label={t("settings.updates.currentVersion")}>
        <span className="text-[13px] tabular-nums text-muted-foreground">{version}</span>
      </Row>
      <Row label={t("settings.updates.check")} hint={status}>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!supported || busy}
          onClick={() => void (update ? install() : checkNow())}
        >
          {busy && (
            <MotionSpinner>
              <Loader2 className="size-3.5" />
            </MotionSpinner>
          )}
          {update
            ? t("settings.updates.install", { version: update.version })
            : t("settings.updates.checkAction")}
        </Button>
      </Row>
    </>
  )
}

function initialSettingsModules(): string[] {
  const raw = new URLSearchParams(window.location.search).get("activeModules")
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const known = new Set(MODULE_REGISTRY.map((module) => module.id))
    return parsed.filter((id): id is string => typeof id === "string" && known.has(id))
  } catch {
    return []
  }
}

function initialSettingsVault(): string | null {
  return new URLSearchParams(window.location.search).get("vault")
}

function initialSettingsNavigationTarget(): SettingsNavigationTarget | null {
  const params = new URLSearchParams(window.location.search)
  const section = params.get("settingsSection")
  if (!isSettingsSectionId(section)) return null
  const moduleId = params.get("settingsModule")
  return moduleId && isSettingsModuleId(moduleId) ? { section, moduleId } : { section }
}

export function StandaloneSettingsWindow() {
  const [activeModules, setActiveModules] = React.useState(initialSettingsModules)
  const [vault, setVault] = React.useState(initialSettingsVault)
  const [navigationTarget, setNavigationTarget] = React.useState(initialSettingsNavigationTarget)

  React.useEffect(() => {
    if (!isTauri()) return
    return adoptAsyncDisposer(
      listen<SettingsContextPayload>(SETTINGS_CONTEXT_CHANGE_EVENT, (event) => {
        setActiveModules(event.payload.activeModules)
        setVault(event.payload.vault)
        if (event.payload.target) setNavigationTarget(event.payload.target)
      }),
    )
  }, [])

  const handleModuleEnabledChange = React.useCallback((id: string, enabled: boolean) => {
    setActiveModules((current) =>
      enabled
        ? current.includes(id)
          ? current
          : [...current, id]
        : current.filter((moduleId) => moduleId !== id),
    )
    void emitTo<ModuleChangePayload>("main", SETTINGS_MODULE_CHANGE_EVENT, { id, enabled })
  }, [])

  return (
    <SettingsDialog
      standalone
      open
      vault={vault}
      navigationTarget={navigationTarget}
      onOpenChange={(next) => {
        if (!next && isTauri()) void getCurrentWindow().close()
      }}
      activeModules={activeModules}
      onModuleEnabledChange={handleModuleEnabledChange}
    />
  )
}

function SettingsWindowHeader({
  native,
  maximized,
  onMinimize,
  onToggleMaximize,
  onClose,
}: {
  native: boolean
  maximized: boolean
  onMinimize: () => void
  onToggleMaximize: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()

  return (
    <header
      data-tauri-drag-region={native ? "" : undefined}
      className="group relative flex h-11 shrink-0 select-none items-center bg-background"
      onDoubleClick={(event) => {
        if ((event.target as HTMLElement).closest("button, input, [role='button']")) return
        onToggleMaximize()
      }}
    >
      {isMac ? (
        native ? (
          <div className="w-20 shrink-0" />
        ) : (
          <div className="absolute left-4 top-1/2 z-10 flex -translate-y-1/2 items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              onDoubleClick={(event) => event.stopPropagation()}
              aria-label={t("settings.window.close")}
              className="settings-traffic-light settings-traffic-light--close flex size-3 items-center justify-center rounded-full"
            >
              <X className="settings-traffic-light-icon size-2 opacity-0 group-hover:opacity-100" />
            </button>
            <button
              type="button"
              onClick={onMinimize}
              onDoubleClick={(event) => event.stopPropagation()}
              aria-label={t("settings.window.minimize")}
              className="settings-traffic-light settings-traffic-light--minimize flex size-3 items-center justify-center rounded-full"
            >
              <Minus className="settings-traffic-light-icon size-2 opacity-0 group-hover:opacity-100" />
            </button>
            <button
              type="button"
              onClick={onToggleMaximize}
              onDoubleClick={(event) => event.stopPropagation()}
              aria-label={maximized ? t("settings.window.restore") : t("settings.window.maximize")}
              className="settings-traffic-light settings-traffic-light--maximize flex size-3 items-center justify-center rounded-full"
            >
              <span className="settings-traffic-light-glyph size-1.5 rounded-[1px] border opacity-0 group-hover:opacity-100" />
            </button>
          </div>
        )
      ) : (
        <div className="absolute right-0 top-0 z-10 flex h-11 items-center">
          <button
            type="button"
            onClick={onMinimize}
            onDoubleClick={(event) => event.stopPropagation()}
            aria-label={t("settings.window.minimize")}
            className="flex h-11 w-12 items-center justify-center text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <Minus className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={onToggleMaximize}
            onDoubleClick={(event) => event.stopPropagation()}
            aria-label={maximized ? t("settings.window.restore") : t("settings.window.maximize")}
            className="flex h-11 w-12 items-center justify-center text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            {maximized ? (
              <span className="relative size-3">
                <span className="absolute left-0 top-1 size-2 border border-current" />
                <span className="absolute right-0 top-0 size-2 border border-current bg-background" />
              </span>
            ) : (
              <span className="size-2.5 border border-current" />
            )}
          </button>
          <button
            type="button"
            onClick={onClose}
            onDoubleClick={(event) => event.stopPropagation()}
            aria-label={t("settings.window.close")}
            className="flex h-11 w-12 items-center justify-center text-muted-foreground hover:bg-red-600 hover:text-white"
          >
            <X className="size-4" />
          </button>
        </div>
      )}

      {native ? (
        <h1
          data-tauri-drag-region=""
          className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-[13px] font-medium text-foreground"
        >
          {t("settings.window.title")}
        </h1>
      ) : (
        <DialogTitle className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-[13px] font-medium text-foreground">
          {t("settings.window.title")}
        </DialogTitle>
      )}
    </header>
  )
}

function SettingsIntro({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      <p className="mt-1 max-w-2xl text-[12px] leading-5 text-muted-foreground">{description}</p>
    </div>
  )
}

function SettingsGroup({
  title,
  icon: Icon,
  children,
}: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
}) {
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
        <Icon className="size-4" />
        {title}
      </h3>
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card/30">
        {children}
      </div>
    </section>
  )
}

function SearchResults({
  query,
  results,
  onOpen,
}: {
  query: string
  results: Array<{
    section: SettingsSectionId
    label: string
    description: string
    targetId?: string
  }>
  onOpen: (section: SettingsSectionId, targetId?: string) => void
}) {
  const { t } = useTranslation()
  return (
    <div>
      <SettingsIntro
        title={t("settings.search.title", { query })}
        description={t("settings.search.count", { count: results.length })}
      />
      {results.length > 0 ? (
        <div className="mt-5 divide-y divide-border overflow-hidden rounded-lg border border-border">
          {results.map((result, index) => (
            <button
              key={`${result.section}-${result.label}-${index}`}
              type="button"
              onClick={() => onOpen(result.section, result.targetId)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-card"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] text-foreground">{result.label}</span>
                <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                  {result.description}
                </span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </div>
      ) : (
        <div className="mt-5 rounded-lg border border-dashed border-border px-6 py-12 text-center text-[13px] text-muted-foreground">
          {t("settings.search.empty")}
        </div>
      )}
    </div>
  )
}

function builtinThemeName(theme: BuiltinTheme, t: (key: string) => string): string {
  const key: Record<BuiltinTheme["id"], string> = {
    dark: "settings.appearance.themeDark",
    light: "settings.appearance.themeLight",
    system: "settings.appearance.themeSystem",
    catppuccin: "settings.appearance.themeCatppuccin",
    "catppuccin-light": "settings.appearance.themeCatppuccin",
    gruvbox: "settings.appearance.themeMaterialGruvbox",
    "gruvbox-light": "settings.appearance.themeMaterialGruvbox",
  }
  return t(key[theme.id])
}

// This is a UI-only Select value. The leading underscores keep it outside the
// portable theme id grammar, so an imported theme can never collide with it.
const DEFAULT_THEME_FAMILY_ID = "__amby-default__"

function themeModeForFamily(
  family: { variants: Partial<Record<ThemeModePreference, BuiltinTheme["id"]>> },
  themeId: string,
): ThemeModePreference | null {
  const entry = (
    Object.entries(family.variants) as [ThemeModePreference, BuiltinTheme["id"]][]
  ).find(([, variantId]) => variantId === themeId)
  return entry?.[0] ?? null
}

function ThemeLibrary({
  selectedThemeId,
  themes,
  onSelect,
  onThemesChange,
}: {
  selectedThemeId: string
  themes: ThemeDefinition[]
  onSelect: (id: string) => void
  onThemesChange: (themes: ThemeDefinition[]) => void
}) {
  const { t } = useTranslation()
  const [error, setError] = React.useState<string | null>(null)
  const selected = themeById(selectedThemeId, themes)
  const selectedCustomTheme = themes.find((theme) => theme.id === selected.id)
  const selectedFamily = builtinThemeFamilyForId(selected.id)
  const selectedMode = selectedFamily ? themeModeForFamily(selectedFamily, selected.id) : null

  function selectTheme(id: string) {
    const familyId = id === DEFAULT_THEME_FAMILY_ID ? "amby" : id
    const family = BUILTIN_THEME_FAMILIES.find((item) => item.id === familyId)
    if (family) {
      // Keep the current mode when switching palettes. If the new family does
      // not provide that mode, prefer dark and then the first available one.
      const nextId =
        (selectedMode && family.variants[selectedMode]) ??
        family.variants.dark ??
        Object.values(family.variants)[0]
      if (nextId) onSelect(nextId)
      return
    }
    onSelect(id)
  }

  function selectThemeMode(mode: string) {
    if (!selectedFamily) return
    const nextId = selectedFamily.variants[mode as ThemeModePreference]
    if (nextId) onSelect(nextId)
  }

  async function importTheme() {
    setError(null)
    try {
      const text = await importTextFile()
      if (!text) return
      const parsed = parseThemeDefinition(JSON.parse(text))
      if (!parsed) {
        setError(t("settings.appearance.themeImportFailed"))
        return
      }
      const theme = withUniqueThemeId(parsed, themes)
      onThemesChange([...themes, theme])
      onSelect(theme.id)
    } catch {
      setError(t("settings.appearance.themeImportFailed"))
    }
  }

  async function exportTheme(theme: ThemeDefinition) {
    try {
      await exportTextFile(`${JSON.stringify(theme, null, 2)}\n`, `${theme.id}.amby-theme.json`)
    } catch {
      // A cancelled native dialog intentionally leaves the library untouched.
    }
  }

  async function removeTheme(theme: ThemeDefinition) {
    if (!(await confirmAction(t("settings.appearance.themeRemoveConfirm", { name: theme.name }))))
      return
    onThemesChange(themes.filter((item) => item.id !== theme.id))
    if (selectedThemeId === theme.id) onSelect("dark")
  }

  return (
    <>
      <Row label={t("settings.appearance.theme")} hint={t("settings.appearance.themeLibraryHint")}>
        <div className="flex items-center gap-1.5">
          <Select
            value={
              selectedFamily?.id === "amby"
                ? DEFAULT_THEME_FAMILY_ID
                : (selectedFamily?.id ?? selected.id)
            }
            onValueChange={selectTheme}
          >
            <SelectTrigger className={selectTrigger}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>{t("settings.appearance.builtinThemes")}</SelectLabel>
                {BUILTIN_THEME_FAMILIES.map((family) => {
                  const variantId = family.variants.dark ?? family.variants.light
                  const theme = BUILTIN_THEMES.find((item) => item.id === variantId)
                  if (!theme) return null
                  return (
                    <SelectItem
                      key={family.id}
                      value={family.id === "amby" ? DEFAULT_THEME_FAMILY_ID : family.id}
                    >
                      {family.id === "amby"
                        ? t("settings.appearance.themeStandard")
                        : builtinThemeName(theme, t)}
                    </SelectItem>
                  )
                })}
              </SelectGroup>
              {themes.length > 0 && (
                <>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>{t("settings.appearance.importedThemes")}</SelectLabel>
                    {themes.map((theme) => (
                      <SelectItem key={theme.id} value={theme.id}>
                        {theme.author
                          ? `${theme.name} · ${t("settings.appearance.themeAuthor", { author: theme.author })}`
                          : theme.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </>
              )}
            </SelectContent>
          </Select>

          {selectedCustomTheme && (
            <>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                title={t("settings.appearance.exportTheme")}
                aria-label={t("settings.appearance.exportTheme")}
                onClick={() => void exportTheme(selectedCustomTheme)}
              >
                <Download className="size-3.5" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                title={t("settings.appearance.removeTheme")}
                aria-label={t("settings.appearance.removeTheme")}
                onClick={() => void removeTheme(selectedCustomTheme)}
                className="hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </>
          )}
        </div>
      </Row>

      {selectedFamily && selectedMode && Object.keys(selectedFamily.variants).length > 1 && (
        <Row
          label={t("settings.appearance.themeMode")}
          hint={t("settings.appearance.themeModeHint")}
        >
          <Select value={selectedMode} onValueChange={selectThemeMode}>
            <SelectTrigger className={selectTrigger}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(selectedFamily.variants) as ThemeModePreference[]).map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {t(`settings.appearance.theme${mode[0].toUpperCase()}${mode.slice(1)}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
      )}

      <div className="flex min-h-14 items-center justify-between gap-4 px-4 py-3">
        <span className="text-[13px] text-foreground">
          {t("settings.appearance.importedThemes")}
        </span>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={themeActionClass} onClick={() => void importTheme()}>
            <Upload className="size-3.5" />
            {t("settings.appearance.importTheme")}
          </button>
          <a
            className={themeActionClass}
            href="https://github.com/search?q=amby-theme.json&type=code"
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink className="size-3.5" />
            {t("settings.appearance.discoverThemes")}
          </a>
        </div>
      </div>
      {error && <p className="px-4 py-2 text-[11px] text-destructive">{error}</p>}
    </>
  )
}

const themeActionClass =
  "inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] text-foreground hover:bg-card"

function ShortcutsTab() {
  const { t } = useTranslation()
  const shortcuts = useSettingsStore((state) => state.prefs.shortcuts)
  const setPrefs = useSettingsStore((state) => state.setPrefs)
  const [recording, setRecording] = React.useState<ShortcutActionId | null>(null)
  const [message, setMessage] = React.useState<string | null>(null)

  const updateShortcut = (id: ShortcutActionId, binding: string) => {
    const conflict = SHORTCUT_DEFINITIONS.find(
      (definition) => definition.id !== id && shortcuts[definition.id] === binding,
    )
    if (conflict) {
      setMessage(t("settings.shortcuts.conflict", { action: t(conflict.labelKey) }))
      return
    }
    setMessage(null)
    setRecording(null)
    void setPrefs({ shortcuts: { ...shortcuts, [id]: binding } })
  }

  return (
    <div className="flex flex-col gap-4 py-1">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-2xl text-[12px] text-muted-foreground">
          {t("settings.shortcuts.description")}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setRecording(null)
            setMessage(null)
            void setPrefs({ shortcuts: { ...DEFAULT_SHORTCUTS } })
          }}
        >
          <RotateCcw className="size-3.5" />
          {t("settings.shortcuts.resetAll")}
        </Button>
      </div>

      <div className="divide-y divide-border rounded-lg border border-border">
        {SHORTCUT_DEFINITIONS.map((definition) => {
          const isRecording = recording === definition.id
          const isDefault = shortcuts[definition.id] === definition.defaultBinding
          return (
            <div
              key={definition.id}
              className="flex min-h-14 items-center justify-between gap-4 px-3 py-2.5"
            >
              <span className="min-w-0 text-[13px] text-foreground">{t(definition.labelKey)}</span>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  aria-label={t("settings.shortcuts.change", {
                    action: t(definition.labelKey),
                  })}
                  aria-pressed={isRecording}
                  onClick={() => {
                    setMessage(null)
                    setRecording(definition.id)
                  }}
                  onBlur={() =>
                    setRecording((current) => (current === definition.id ? null : current))
                  }
                  onKeyDown={(event) => {
                    if (!isRecording) return
                    event.preventDefault()
                    event.stopPropagation()
                    if (event.key === "Escape") {
                      setRecording(null)
                      setMessage(null)
                      return
                    }
                    const result = shortcutFromEvent(event)
                    if (result.status === "modifier-only") return
                    if (result.status === "needs-modifier") {
                      setMessage(t("settings.shortcuts.needsModifier"))
                      return
                    }
                    updateShortcut(definition.id, result.binding)
                  }}
                  className={cn(
                    "min-w-32 rounded-md border px-3 py-1.5 text-center font-mono text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                    isRecording
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {isRecording
                    ? t("settings.shortcuts.recording")
                    : formatShortcut(shortcuts[definition.id])}
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={isDefault}
                  title={t("settings.shortcuts.resetOne")}
                  aria-label={t("settings.shortcuts.resetOne")}
                  onClick={() => updateShortcut(definition.id, definition.defaultBinding)}
                >
                  <RotateCcw className="size-3.5" />
                </Button>
              </div>
            </div>
          )
        })}
      </div>

      <p
        role={message ? "alert" : undefined}
        className={cn(
          "min-h-5 text-[12px]",
          message ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {message ?? t("settings.shortcuts.recordingHint")}
      </p>
    </div>
  )
}

// ── Built-in modules ─────────────────────────────────────────────────────────

const MODULE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  tags: Tags,
  favorites: Star,
  databases: Database,
  history: Clock3,
  links: GitBranch,
  graph: GitBranch,
  sync: Cloud,
  ai: Bot,
}

function ModulesTab({
  activeModules,
  onModuleEnabledChange,
  selectedId,
  onSelectedChange,
}: Pick<SettingsDialogProps, "activeModules" | "onModuleEnabledChange"> & {
  selectedId: string
  onSelectedChange: (id: string) => void
}) {
  const { t } = useTranslation()
  const experimental = useSettingsStore((state) => state.experimental)
  const selected = MODULE_REGISTRY.find((module) => module.id === selectedId) ?? MODULE_REGISTRY[0]

  if (!selected) return null

  const enabled = activeModules.includes(selected.id)

  return (
    <div className="grid min-h-full lg:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="border-b border-border p-2 lg:border-b-0 lg:border-r">
        <div className="mb-1 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {t("settings.modules.catalogue")}
        </div>
        <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-1">
          {MODULE_REGISTRY.map((module) => {
            const Icon = MODULE_ICONS[module.id] ?? Blocks
            const isEnabled = activeModules.includes(module.id)
            const isAvailable = isModuleAvailable(module.id, experimental)
            return (
              <div
                key={module.id}
                className={cn(
                  "flex items-center gap-1 rounded-md",
                  selected.id === module.id
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent/50",
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelectedChange(module.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2.5 text-left"
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-foreground">
                      {t(module.labelKey)}
                    </span>
                    <span className="block text-[10px] text-muted-foreground">
                      {module.status === "beta"
                        ? t("settings.modules.beta")
                        : module.status === "preview"
                          ? isAvailable
                            ? t("settings.modules.previewAvailable")
                            : t("settings.modules.preview")
                          : isEnabled
                            ? t("settings.modules.enabled")
                            : t("settings.modules.disabled")}
                    </span>
                  </span>
                </button>
                <Switch
                  className="mr-2"
                  checked={isEnabled}
                  disabled={!isAvailable && !isEnabled}
                  onCheckedChange={(next) => onModuleEnabledChange(module.id, next)}
                  aria-label={t(module.labelKey)}
                />
              </div>
            )
          })}
        </div>
      </aside>

      <section className="flex min-w-0 flex-col px-5 py-5 sm:px-7">
        <div className="min-h-[300px] flex-1 pb-6">
          {selected.status === "preview" && !isModuleAvailable(selected.id, experimental) ? (
            <ModuleMessage
              title={t("settings.modules.previewTitle")}
              description={t("settings.modules.previewDescription")}
            />
          ) : selected.status === "preview" ? (
            <ModuleMessage
              title={t("settings.modules.previewAvailableTitle")}
              description={t("settings.modules.previewAvailableDescription")}
            />
          ) : !enabled ? (
            <ModuleMessage
              title={t("settings.modules.disabledTitle")}
              description={t("settings.modules.disabledDescription")}
            />
          ) : selected.id === "ai" ? (
            <AiTab />
          ) : selected.id === "history" ? (
            <HistorySettings />
          ) : (
            <ModuleMessage
              title={t("settings.modules.readyTitle")}
              description={t("settings.modules.noSettings")}
            />
          )}
        </div>

        <div className="border-t border-border pt-4">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {t("settings.modules.accessTitle")}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {selected.manifest.permissions.map((permission) => (
              <span
                key={permission}
                className="rounded-md border border-border bg-card px-2 py-1 text-[10px] text-muted-foreground"
              >
                {t(`settings.modules.permissions.${permission}`)}
              </span>
            ))}
          </div>
        </div>
        <p className="mt-4 text-[11px] text-muted-foreground">
          {t("settings.modules.pluginsNote")}
        </p>
      </section>
    </div>
  )
}

function ModuleMessage({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-5 py-8 text-center">
      <p className="text-[13px] font-medium text-foreground">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-[11px] leading-5 text-muted-foreground">
        {description}
      </p>
    </div>
  )
}

function HistorySettings() {
  const { t } = useTranslation()
  const [maxCopies, setMaxCopies] = React.useState(() =>
    Number(localStorage.getItem("amby:history-max-copies") ?? 20),
  )
  const [enabled, setEnabled] = React.useState(
    () => localStorage.getItem("amby:history-disabled") !== "true",
  )
  return (
    <div className="divide-y divide-border rounded-lg border border-border">
      <Row label={t("settings.history.maxCopies")} hint={t("settings.history.maxCopiesHint")}>
        <input
          type="number"
          min={0}
          max={1000}
          value={maxCopies}
          disabled={!enabled}
          onChange={(e) => {
            const value = Math.max(0, Number(e.target.value) || 0)
            setMaxCopies(value)
            localStorage.setItem("amby:history-max-copies", String(value))
          }}
          className="h-8 w-24 rounded-md border border-border bg-card px-2 text-right text-[13px]"
        />
      </Row>
      <Row label={t("settings.history.enabled")} hint={t("settings.history.enabledHint")}>
        <Switch
          checked={enabled}
          onCheckedChange={(value) => {
            setEnabled(value)
            localStorage.setItem("amby:history-disabled", String(!value))
            window.dispatchEvent(new Event("amby:history-setting-change"))
          }}
        />
      </Row>
      <Row label={t("settings.history.clear")}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.dispatchEvent(new Event("amby:history-clear-all"))}
        >
          {t("settings.history.clearAction")}
        </Button>
      </Row>
    </div>
  )
}

// ── AI models: shares the model library with the AI panel ─────────────────────

function AiTab() {
  const [ai, setAi] = React.useState<AiSettings>(DEFAULT_AI)

  React.useEffect(() => {
    loadSettings().then((s) => setAi(s.ai))
  }, [])

  const update = (next: AiSettings) => {
    setAi(next)
    void saveSettingsPatch({ ai: next }).catch(() => {})
  }

  return (
    <div className="flex min-h-[240px] flex-col">
      <ModelsManager ai={ai} onChange={update} />
    </div>
  )
}

// ── Data tab: settings location + reset ───────────────────────────────────────

function DataTab({ vault }: { vault: string | null }) {
  const { t } = useTranslation()
  const setPrefs = useSettingsStore((s) => s.setPrefs)
  const setVaults = useVaultStore((s) => s.setVaults)
  const [dir, setDir] = React.useState<string>("")

  React.useEffect(() => {
    if (!isTauri()) return
    import("@tauri-apps/api/path")
      .then(({ localDataDir }) => localDataDir())
      .then((base) => setDir(`${base.replace(/[/\\]$/, "")}/Amby/notes`))
      .catch(() => {})
  }, [])

  const btn =
    "flex items-center gap-2 rounded-md border border-border px-3 py-2 text-[13px] text-foreground hover:bg-card"

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <div className="mb-1 text-[13px] text-foreground">{t("settings.data.location")}</div>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-card px-2 py-1.5 text-[12px] text-muted-foreground">
            {dir || (isTauri() ? "…" : "localStorage (web)")}
          </code>
          {isTauri() && (
            <button
              type="button"
              className={btn}
              onClick={() => void openInExplorer(dir)}
              disabled={!dir}
            >
              <FolderOpen className="size-4" />
              {t("settings.data.openFolder")}
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          className={btn}
          onClick={async () => {
            if (await confirmAction(t("settings.data.resetConfirm"))) setPrefs({ ...DEFAULT_PREFS })
          }}
        >
          <RotateCcw className="size-4" />
          {t("settings.data.reset")}
        </button>
        <button
          type="button"
          className={cn(btn, "text-red-300 hover:bg-red-950/30")}
          onClick={() => {
            setVaults([])
            void saveWorkspaces({
              schemaVersion: WORKSPACES_SCHEMA_VERSION,
              recent: [],
              lastOpened: vault,
            })
          }}
        >
          <Trash2 className="size-4" />
          {t("settings.data.clearRecent")}
        </button>
      </div>
    </div>
  )
}

function DeleteConfirmationSetting({ vault }: { vault: string | null }) {
  const { t } = useTranslation()
  const [enabled, setEnabled] = React.useState(true)

  React.useEffect(() => {
    let cancelled = false
    if (!vault) return
    loadWorkspaceConfig()
      .then((config) => {
        if (!cancelled) setEnabled(config.confirmations.confirmFileDelete)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [vault])

  return (
    <Row
      label={t("settings.general.confirmFileDelete")}
      hint={
        vault
          ? t("settings.general.confirmFileDeleteHint")
          : t("settings.general.vaultSettingUnavailable")
      }
    >
      <Switch
        checked={enabled}
        disabled={!vault}
        onCheckedChange={(next) => {
          setEnabled(next)
          void saveWorkspaceConfigPatch({
            confirmations: { confirmFileDelete: next },
          }).catch(() => setEnabled(!next))
        }}
      />
    </Row>
  )
}
