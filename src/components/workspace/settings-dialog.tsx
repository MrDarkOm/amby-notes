"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  Blocks,
  Bot,
  Check,
  Command,
  FolderCog,
  FolderOpen,
  Monitor,
  Palette,
  PencilLine,
  PlugZap,
  RotateCcw,
  Trash2,
  UserRound,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { confirmAction, openInExplorer, isTauri } from "@/lib/storage"
import { useSettingsStore } from "./use-settings-store"
import { useVaultStore } from "./use-vault-store"
import { ModelsManager } from "./models-manager"
import { MODULE_REGISTRY } from "./modules"
import {
  ACCENTS,
  DEFAULT_AI,
  DEFAULT_PREFS,
  loadSettings,
  saveSettingsPatch,
  saveWorkspaces,
  type AccentId,
  type AiSettings,
  type ContentWidth,
  type Density,
  type DockPreferences,
  type FontScale,
  type Language,
  type ThemePref,
  type ViewModePref,
} from "./app-config"

const ACCENT_HEX: Record<AccentId, string> = {
  violet: "#8b5cf6",
  sky: "#0ea5e9",
  teal: "#14b8a6",
  emerald: "#10b981",
  amber: "#f59e0b",
  rose: "#f43f5e",
}

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
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="text-[13px] text-foreground">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

const selectTrigger = "h-8 w-44 bg-card border-border text-[13px] text-foreground"

interface SettingsDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  activeModules: string[]
  onModuleEnabledChange: (id: string, enabled: boolean) => void
  dockPrefs: DockPreferences
  onDockPrefsChange: (patch: Partial<DockPreferences>) => void
}

export function SettingsDialog({
  open,
  onOpenChange,
  activeModules,
  onModuleEnabledChange,
  dockPrefs,
  onDockPrefsChange,
}: SettingsDialogProps) {
  const { t } = useTranslation()
  const prefs = useSettingsStore((s) => s.prefs)
  const setPrefs = useSettingsStore((s) => s.setPrefs)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(620px,80vh)] max-h-[80vh] flex-col gap-4 overflow-hidden border-border bg-background p-0 sm:max-w-3xl">
        <DialogHeader className="px-6 pt-6 pr-14">
          <DialogTitle className="text-foreground">{t("settings.title")}</DialogTitle>
        </DialogHeader>

        <Tabs
          defaultValue="general"
          className="min-h-0 flex-1 flex-row gap-0 border-t border-border"
        >
          <TabsList className="group h-auto w-12 shrink-0 flex-col items-stretch justify-start gap-1 overflow-hidden rounded-none border-r border-border bg-card p-2 transition-[width] duration-200 hover:w-56 focus-within:w-56">
            <TabsTrigger
              value="general"
              title={t("settings.tabs.general")}
              className="h-9 w-full flex-none justify-center px-0 text-left group-hover:justify-start group-hover:px-3 group-focus-within:justify-start group-focus-within:px-3"
            >
              <UserRound className="size-4 shrink-0" />
              <NavLabel>{t("settings.tabs.general")}</NavLabel>
            </TabsTrigger>
            <TabsTrigger
              value="appearance"
              title={t("settings.tabs.appearance")}
              className="h-9 w-full flex-none justify-center px-0 text-left group-hover:justify-start group-hover:px-3 group-focus-within:justify-start group-focus-within:px-3"
            >
              <Palette className="size-4 shrink-0" />
              <NavLabel>{t("settings.tabs.appearance")}</NavLabel>
            </TabsTrigger>
            <TabsTrigger
              value="interface"
              title={t("settings.tabs.interface")}
              className="h-9 w-full flex-none justify-center px-0 text-left group-hover:justify-start group-hover:px-3 group-focus-within:justify-start group-focus-within:px-3"
            >
              <Monitor className="size-4 shrink-0" />
              <NavLabel>{t("settings.tabs.interface")}</NavLabel>
            </TabsTrigger>
            <TabsTrigger
              value="editor"
              title={t("settings.tabs.editor")}
              className="h-9 w-full flex-none justify-center px-0 text-left group-hover:justify-start group-hover:px-3 group-focus-within:justify-start group-focus-within:px-3"
            >
              <PencilLine className="size-4 shrink-0" />
              <NavLabel>{t("settings.tabs.editor")}</NavLabel>
            </TabsTrigger>
            <TabsTrigger
              value="files-links"
              title={t("settings.tabs.filesLinks")}
              className="h-9 w-full flex-none justify-center px-0 text-left group-hover:justify-start group-hover:px-3 group-focus-within:justify-start group-focus-within:px-3"
            >
              <FolderCog className="size-4 shrink-0" />
              <NavLabel>{t("settings.tabs.filesLinks")}</NavLabel>
            </TabsTrigger>
            <TabsTrigger
              value="shortcuts"
              title={t("settings.tabs.shortcuts")}
              className="h-9 w-full flex-none justify-center px-0 text-left group-hover:justify-start group-hover:px-3 group-focus-within:justify-start group-focus-within:px-3"
            >
              <Command className="size-4 shrink-0" />
              <NavLabel>{t("settings.tabs.shortcuts")}</NavLabel>
            </TabsTrigger>
            <TabsTrigger
              value="modules"
              title={t("settings.tabs.modules")}
              className="h-9 w-full flex-none justify-center px-0 text-left group-hover:justify-start group-hover:px-3 group-focus-within:justify-start group-focus-within:px-3"
            >
              <Blocks className="size-4 shrink-0" />
              <NavLabel>{t("settings.tabs.modules")}</NavLabel>
            </TabsTrigger>
            <TabsTrigger
              value="plugins"
              title={t("settings.tabs.plugins")}
              className="h-9 w-full flex-none justify-center px-0 text-left group-hover:justify-start group-hover:px-3 group-focus-within:justify-start group-focus-within:px-3"
            >
              <PlugZap className="size-4 shrink-0" />
              <NavLabel>{t("settings.tabs.plugins")}</NavLabel>
            </TabsTrigger>
          </TabsList>

          <div className="min-w-0 flex-1 overflow-y-auto px-6 py-3">
            {/* ── General ──────────────────────────────────────────────── */}
            <TabsContent value="general" className="divide-y divide-border">
              <Row label={t("settings.appearance.language")}>
                <Select
                  value={prefs.language}
                  onValueChange={(v) => setPrefs({ language: v as Language })}
                >
                  <SelectTrigger className={selectTrigger}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ru">{t("settings.appearance.russian")}</SelectItem>
                    <SelectItem value="en">{t("settings.appearance.english")}</SelectItem>
                  </SelectContent>
                </Select>
              </Row>
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
            </TabsContent>

            {/* ── Appearance ───────────────────────────────────────────── */}
            <TabsContent value="appearance" className="divide-y divide-border">
              <Row label={t("settings.appearance.theme")}>
                <Select
                  value={prefs.theme}
                  onValueChange={(v) => setPrefs({ theme: v as ThemePref })}
                >
                  <SelectTrigger className={selectTrigger}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="dark">{t("settings.appearance.themeDark")}</SelectItem>
                    <SelectItem value="light">{t("settings.appearance.themeLight")}</SelectItem>
                    <SelectItem value="system">{t("settings.appearance.themeSystem")}</SelectItem>
                  </SelectContent>
                </Select>
              </Row>

              <Row label={t("settings.appearance.accent")}>
                <div className="flex items-center gap-1.5">
                  {ACCENTS.map((a) => (
                    <button
                      key={a}
                      type="button"
                      title={a}
                      onClick={() => setPrefs({ accent: a })}
                      style={{ background: ACCENT_HEX[a] }}
                      className={cn(
                        "flex size-6 items-center justify-center rounded-full ring-2 ring-offset-2 ring-offset-background transition-all",
                        prefs.accent === a
                          ? "ring-foreground/80"
                          : "ring-transparent hover:ring-foreground/30",
                      )}
                    >
                      {prefs.accent === a && <Check className="size-3.5 text-white" />}
                    </button>
                  ))}
                </div>
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
            </TabsContent>

            {/* ── Interface ────────────────────────────────────────────── */}
            <TabsContent value="interface" className="divide-y divide-border">
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
              <Row label={t("settings.interface.leftDock")}>
                <Switch
                  checked={dockPrefs.leftVisible}
                  onCheckedChange={(leftVisible) => onDockPrefsChange({ leftVisible })}
                />
              </Row>
              <Row label={t("settings.interface.rightDock")}>
                <Switch
                  checked={dockPrefs.rightVisible}
                  onCheckedChange={(rightVisible) => onDockPrefsChange({ rightVisible })}
                />
              </Row>
            </TabsContent>

            {/* ── Editor ───────────────────────────────────────────────── */}
            <TabsContent value="editor" className="divide-y divide-border">
              <Row label={t("settings.editor.defaultViewMode")}>
                <Select
                  value={prefs.editor.defaultViewMode}
                  onValueChange={(v) =>
                    setPrefs({ editor: { ...prefs.editor, defaultViewMode: v as ViewModePref } })
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

              <Row label={t("settings.editor.autosave")} hint={t("settings.editor.autosaveHint")}>
                <input
                  type="number"
                  min={200}
                  max={10000}
                  step={100}
                  value={prefs.editor.autosaveMs}
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    if (Number.isFinite(n)) setPrefs({ editor: { ...prefs.editor, autosaveMs: n } })
                  }}
                  className="h-8 w-24 rounded-md border border-border bg-card px-2 text-right text-[13px] text-foreground outline-none focus:border-border"
                />
              </Row>
            </TabsContent>

            {/* ── Files and links ──────────────────────────────────────── */}
            <TabsContent value="files-links">
              <DataTab />
            </TabsContent>

            <TabsContent value="shortcuts">
              <SettingsPlaceholder>{t("settings.placeholders.shortcuts")}</SettingsPlaceholder>
            </TabsContent>

            <TabsContent value="modules">
              <ModulesTab
                activeModules={activeModules}
                onModuleEnabledChange={onModuleEnabledChange}
              />
            </TabsContent>

            <TabsContent value="plugins">
              <SettingsPlaceholder>{t("settings.placeholders.plugins")}</SettingsPlaceholder>
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

function NavLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="invisible w-0 overflow-hidden whitespace-nowrap opacity-0 transition-opacity duration-150 group-hover:visible group-hover:w-auto group-hover:opacity-100 group-focus-within:visible group-focus-within:w-auto group-focus-within:opacity-100">
      {children}
    </span>
  )
}

function SettingsPlaceholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[240px] items-center justify-center rounded-lg border border-dashed border-border px-6 text-center text-[13px] text-muted-foreground">
      {children}
    </div>
  )
}

// ── Built-in modules ─────────────────────────────────────────────────────────

function ModulesTab({
  activeModules,
  onModuleEnabledChange,
}: Pick<SettingsDialogProps, "activeModules" | "onModuleEnabledChange">) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col gap-6 py-1">
      <div>
        <p className="mb-3 text-[12px] text-muted-foreground">{t("settings.modules.desc")}</p>
        <div className="divide-y divide-border rounded-lg border border-border">
          {MODULE_REGISTRY.map((module) => (
            <div key={module.id} className="flex items-center gap-3 px-3 py-2.5">
              <Blocks className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 text-[13px] text-foreground">
                {t(module.labelKey)}
              </span>
              <Switch
                checked={activeModules.includes(module.id)}
                onCheckedChange={(enabled) => onModuleEnabledChange(module.id, enabled)}
                aria-label={t(module.labelKey)}
              />
            </div>
          ))}
        </div>
      </div>

      {activeModules.includes("ai") && (
        <div>
          <div className="mb-2 flex items-center gap-2 text-[13px] text-foreground">
            <Bot className="size-4 text-muted-foreground" />
            {t("settings.modules.aiTitle")}
          </div>
          <AiTab />
        </div>
      )}
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
    void saveSettingsPatch({ ai: next })
  }

  return (
    <div className="flex min-h-[240px] flex-col">
      <ModelsManager ai={ai} onChange={update} />
    </div>
  )
}

// ── Data tab: settings location + reset ───────────────────────────────────────

function DataTab() {
  const { t } = useTranslation()
  const setPrefs = useSettingsStore((s) => s.setPrefs)
  const vault = useVaultStore((s) => s.vault)
  const setVaults = useVaultStore((s) => s.setVaults)
  const [dir, setDir] = React.useState<string>("")

  React.useEffect(() => {
    if (!isTauri()) return
    import("@tauri-apps/api/path")
      .then(({ localDataDir }) => localDataDir())
      .then((base) => setDir(`${base.replace(/[/\\]$/, "")}/Amby`))
      .catch(() => {})
  }, [])

  const btn =
    "flex items-center gap-2 rounded-md border border-border px-3 py-2 text-[13px] text-foreground transition-colors hover:bg-card"

  return (
    <div className="flex flex-col gap-4 py-1">
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
            void saveWorkspaces({ recent: [], lastOpened: vault })
          }}
        >
          <Trash2 className="size-4" />
          {t("settings.data.clearRecent")}
        </button>
      </div>
    </div>
  )
}
