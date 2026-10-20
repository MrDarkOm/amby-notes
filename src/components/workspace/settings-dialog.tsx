"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { LogicalPosition } from "@tauri-apps/api/dpi"
import { emitTo, listen } from "@tauri-apps/api/event"
import { WebviewWindow } from "@tauri-apps/api/webviewWindow"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { adoptAsyncDisposer } from "@/lib/async-disposable"
import { motion } from "motion/react"
import { Input } from "@/components/ui/input"
import {
  Blocks,
  Bug,
  Check,
  Download,
  FolderOpen,
  Minus,
  Monitor,
  Keyboard,
  Palette,
  PencilLine,
  RefreshCw,
  Search,
  Sparkles,
  Type,
  UserRound,
  X,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { motionTransitions } from "@/lib/motion-config"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { isTauri } from "@/lib/storage"
import { ACCENT_HEX } from "@/lib/themes"
import { SUPPORTED_LANGUAGES } from "@/lib/i18n"
import { useSettingsStore } from "./use-settings-store"
import {
  isSettingsModuleId,
  isSettingsSectionId,
  type SettingsNavigationTarget,
  type SettingsSectionId,
} from "./settings-navigation"
import { MODULE_REGISTRY } from "./modules"
import {
  ACCENTS,
  SETTINGS_SAVE_ERROR_EVENT,
  type ContentWidth,
  type Density,
  type FontScale,
  type FontFamily,
  type Language,
  type ThemePref,
  type ViewModePref,
} from "./app-config"
import { SHORTCUT_DEFINITIONS } from "./keyboard-shortcuts"
import {
  Row,
  selectTrigger,
  SettingsGroup,
  UpdateSettings,
  ThemeLibrary,
  ShortcutsTab,
  ModulesTab,
  DataTab,
  DeleteConfirmationSetting,
  DeleteModeSetting,
  SearchResults,
  DebugSettings,
} from "./settings"
import { StopSlider } from "./database/stop-slider"
import { SyncSettings } from "./sync/sync-settings"

const FONT_SCALES = ["sm", "md", "lg"] as const satisfies readonly FontScale[]
const TOOLTIP_DELAY_STOPS = ["0", "500", "1000", "1500", "2000", "-1"] as const
type TooltipDelayStop = (typeof TOOLTIP_DELAY_STOPS)[number]

function resolveTooltipDelayStop(ms: number): TooltipDelayStop {
  if (ms < 0) return "-1"
  if (ms <= 250) return "0"
  if (ms <= 750) return "500"
  if (ms <= 1250) return "1000"
  if (ms <= 1750) return "1500"
  return "2000"
}

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
): Promise<boolean> {
  try {
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
      return true
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
    return await new Promise<boolean>((resolve) => {
      let settled = false
      const settle = (opened: boolean) => {
        if (settled) return
        settled = true
        resolve(opened)
      }
      const timeout = window.setTimeout(() => settle(false), 3_000)
      void child
        .once("tauri://created", () => {
          window.clearTimeout(timeout)
          settle(true)
        })
        .catch(() => settle(false))
      void child
        .once("tauri://error", (event) => {
          console.error("Failed to open settings window:", event.payload)
          window.clearTimeout(timeout)
          settle(false)
        })
        .catch(() => settle(false))
    })
  } catch (error) {
    console.error("Failed to open settings window:", error)
    return false
  }
}

const SETTINGS_NAV = [
  { id: "general", labelKey: "settings.tabs.general", icon: UserRound },
  { id: "appearance", labelKey: "settings.tabs.appearance", icon: Palette },
  { id: "interface", labelKey: "settings.tabs.interface", icon: Monitor },
  { id: "editor", labelKey: "settings.tabs.editor", icon: PencilLine },
  { id: "shortcuts", labelKey: "settings.tabs.shortcuts", icon: Keyboard },
  { id: "modules", labelKey: "settings.tabs.modules", icon: Blocks },
  { id: "sync", labelKey: "settings.tabs.sync", icon: RefreshCw },
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
  const [useInlineFallback, setUseInlineFallback] = React.useState(false)
  // The Synchronization section exists only while the optional module is on.
  const syncActive = activeModules.includes("sync")
  const navItems = SETTINGS_NAV.filter((item) => item.id !== "sync" || syncActive)

  React.useEffect(() => {
    if (!syncActive && activeSection === "sync") setActiveSection("general")
  }, [activeSection, syncActive])

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
        section: "general",
        label: t("settings.debug.groupTitle"),
        description: `${t("settings.debug.enabled")} · ${t("settings.debug.logLevel")} · ${t("settings.debug.logToFile")} · ${t("settings.debug.viewLogs")}`,
      },
      {
        section: "appearance",
        label: t("settings.appearance.themeLibrary"),
        description: `${t("settings.appearance.theme")} · ${t("settings.appearance.themeMode")} · ${t("settings.appearance.importTheme")} · ${t("settings.appearance.accent")} · ${t("settings.appearance.rainbowTree")} · ${t("settings.appearance.treeGuides")}`,
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
      ...(syncActive
        ? [
            {
              section: "sync" as const,
              label: t("sync.title"),
              description: `${t("sync.wizard.server.address")} · ${t("sync.wizard.choice.create")} · ${t("sync.recovery.title")} · ${t("sync.connected.devices")}`,
            },
          ]
        : []),
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
  }, [query, syncActive, t])

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
    if (!open || standalone || !isTauri() || useInlineFallback) return
    let cancelled = false
    void openSettingsWindow(
      activeModules,
      t("settings.window.title"),
      vault,
      navigationTarget,
    ).then((opened) => {
      if (cancelled) return
      if (opened) onOpenChange(false)
      else setUseInlineFallback(true)
    })
    return () => {
      cancelled = true
    }
  }, [activeModules, navigationTarget, onOpenChange, open, standalone, t, useInlineFallback, vault])

  React.useEffect(() => {
    if (!standalone || !open) return
    searchInputRef.current?.focus()
  }, [open, standalone])

  if (!standalone && isTauri() && !useInlineFallback) return null

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
        standalone={standalone}
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
          {navItems.map(({ id, labelKey, icon: Icon }) => (
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
            "m-3 ml-0 min-w-0 flex-1 overflow-y-auto rounded-xl border border-border bg-[var(--panel-bg)] shadow-sm",
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
                  <DeleteModeSetting />
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
                <SettingsGroup title={t("settings.debug.groupTitle")} icon={Bug}>
                  <DebugSettings />
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
                  <Row
                    label={t("settings.appearance.treeGuides")}
                    hint={t("settings.appearance.treeGuidesHint")}
                  >
                    <Switch
                      checked={prefs.treeGuides}
                      onCheckedChange={(treeGuides) => setPrefs({ treeGuides })}
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
                    <div className="flex items-center gap-3">
                      <span className="text-[12px] tabular-nums text-muted-foreground">
                        {prefs.fontScale === "sm"
                          ? t("settings.appearance.fontSm")
                          : prefs.fontScale === "lg"
                            ? t("settings.appearance.fontLg")
                            : t("settings.appearance.fontMd")}
                      </span>
                      <StopSlider
                        stops={FONT_SCALES}
                        value={prefs.fontScale}
                        ariaLabel={t("settings.appearance.fontScale")}
                        label={(scale) =>
                          scale === "sm"
                            ? t("settings.appearance.fontSm")
                            : scale === "lg"
                              ? t("settings.appearance.fontLg")
                              : t("settings.appearance.fontMd")
                        }
                        onChange={(fontScale) => setPrefs({ fontScale })}
                        className="w-28"
                      />
                    </div>
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
                  <Row
                    label={t("settings.interface.rightPanel")}
                    hint={t("settings.interface.rightPanelHint")}
                  >
                    <Switch
                      checked={prefs.docks.rightEnabled}
                      onCheckedChange={(rightEnabled) =>
                        setPrefs({ docks: { ...prefs.docks, rightEnabled } })
                      }
                      aria-label={t("settings.interface.rightPanel")}
                    />
                  </Row>
                  <Row
                    label={t("settings.interface.bottomBar")}
                    hint={t("settings.interface.bottomBarHint")}
                  >
                    <Switch
                      checked={prefs.editor.showAreaControls ?? true}
                      onCheckedChange={(showAreaControls) =>
                        setPrefs({ editor: { ...prefs.editor, showAreaControls } })
                      }
                      aria-label={t("settings.interface.bottomBar")}
                    />
                  </Row>
                  <Row label={t("settings.interface.tooltipDelay")}>
                    {(() => {
                      const currentStop = resolveTooltipDelayStop(prefs.tooltipDelayMs)
                      const labelForStop = (stop: TooltipDelayStop) => {
                        switch (stop) {
                          case "0":
                            return t("settings.interface.tooltipNone")
                          case "500":
                            return t("settings.interface.tooltipHalfSecond")
                          case "1000":
                            return t("settings.interface.tooltipOneSecond")
                          case "1500":
                            return t("settings.interface.tooltipOneHalfSeconds")
                          case "2000":
                            return t("settings.interface.tooltipTwoSeconds")
                          case "-1":
                            return t("settings.interface.tooltipDisabled")
                        }
                      }
                      return (
                        <div className="flex items-center gap-3">
                          <span className="text-[12px] tabular-nums text-muted-foreground">
                            {labelForStop(currentStop)}
                          </span>
                          <StopSlider
                            stops={TOOLTIP_DELAY_STOPS}
                            value={currentStop}
                            ariaLabel={t("settings.interface.tooltipDelay")}
                            label={labelForStop}
                            onChange={(stop) => setPrefs({ tooltipDelayMs: Number(stop) })}
                            className="w-36"
                          />
                        </div>
                      )
                    })()}
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

              {/* ── Synchronization (optional module) ────────────────────── */}
              {syncActive && (
                <TabsContent value="sync" className="space-y-6">
                  <SyncSettings />
                </TabsContent>
              )}

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
  standalone,
  maximized,
  onMinimize,
  onToggleMaximize,
  onClose,
}: {
  native: boolean
  standalone: boolean
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

      {native || standalone ? (
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
