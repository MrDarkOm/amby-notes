"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  Blocks,
  Bot,
  Check,
  Command,
  Download,
  ExternalLink,
  FolderCog,
  FolderOpen,
  Monitor,
  Palette,
  PencilLine,
  PlugZap,
  RotateCcw,
  Trash2,
  Upload,
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
import {
  confirmAction,
  exportTextFile,
  importTextFile,
  openInExplorer,
  isTauri,
} from "@/lib/storage"
import {
  BUILTIN_THEMES,
  parseThemeDefinition,
  themeById,
  withUniqueThemeId,
  type BuiltinTheme,
  type ThemeDefinition,
  ACCENT_HEX,
  THEME_PREVIEW_FALLBACK,
} from "@/lib/themes"
import { SUPPORTED_LANGUAGES } from "@/lib/i18n"
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
  SETTINGS_SAVE_ERROR_EVENT,
  WORKSPACES_SCHEMA_VERSION,
  type AiSettings,
  type ContentWidth,
  type Density,
  type DockPreferences,
  type FontScale,
  type Language,
  type ThemePref,
  type ViewModePref,
} from "./app-config"

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
  const themes = useSettingsStore((s) => s.themes)
  const setPrefs = useSettingsStore((s) => s.setPrefs)
  const setThemes = useSettingsStore((s) => s.setThemes)
  const [saveError, setSaveError] = React.useState<string | null>(null)

  React.useEffect(() => {
    const onSaveError = (event: Event) => {
      const message = (event as CustomEvent<{ message?: unknown }>).detail?.message
      if (typeof message === "string") setSaveError(message)
    }
    window.addEventListener(SETTINGS_SAVE_ERROR_EVENT, onSaveError)
    return () => window.removeEventListener(SETTINGS_SAVE_ERROR_EVENT, onSaveError)
  }, [])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(620px,80vh)] max-h-[80vh] flex-col gap-4 overflow-hidden border-border bg-background p-0 sm:max-w-3xl">
        <DialogHeader className="px-6 pt-6 pr-14">
          <DialogTitle className="text-foreground">{t("settings.title")}</DialogTitle>
          {saveError && (
            <p role="alert" className="pt-1 text-[12px] text-destructive">
              {saveError}
            </p>
          )}
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
                    {SUPPORTED_LANGUAGES.map((language) => (
                      <SelectItem key={language.code} value={language.code}>
                        {t(language.labelKey)}
                      </SelectItem>
                    ))}
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
                    <SelectItem value="midnight">
                      {t("settings.appearance.themeMidnight")}
                    </SelectItem>
                    <SelectItem value="paper">{t("settings.appearance.themePaper")}</SelectItem>
                    {themes.map((theme) => (
                      <SelectItem key={theme.id} value={theme.id}>
                        {theme.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Row>

              <ThemeLibrary
                selectedThemeId={prefs.theme}
                themes={themes}
                onSelect={(theme) => setPrefs({ theme })}
                onThemesChange={setThemes}
              />

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
              <ShortcutsTab />
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

function builtinThemeName(theme: BuiltinTheme, t: (key: string) => string): string {
  const key: Record<BuiltinTheme["id"], string> = {
    dark: "settings.appearance.themeDark",
    light: "settings.appearance.themeLight",
    system: "settings.appearance.themeSystem",
    midnight: "settings.appearance.themeMidnight",
    paper: "settings.appearance.themePaper",
  }
  return t(key[theme.id])
}

function ThemePreview({ theme }: { theme: BuiltinTheme | ThemeDefinition }) {
  const background =
    theme.tokens["--workspace-bg"] ??
    (theme.mode === "dark"
      ? THEME_PREVIEW_FALLBACK.dark.background
      : THEME_PREVIEW_FALLBACK.light.background)
  const surface =
    theme.tokens["--note-surface"] ??
    (theme.mode === "dark"
      ? THEME_PREVIEW_FALLBACK.dark.surface
      : THEME_PREVIEW_FALLBACK.light.surface)
  const borderToken = theme.tokens["--border"]
  const border = borderToken
    ? /^\d+(?:\.\d+)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%$/u.test(borderToken)
      ? `hsl(${borderToken})`
      : borderToken
    : theme.mode === "dark"
      ? THEME_PREVIEW_FALLBACK.dark.border
      : THEME_PREVIEW_FALLBACK.light.border
  return (
    <span
      className="grid h-8 w-12 grid-cols-3 gap-1 rounded border p-1"
      style={{ background, borderColor: border }}
    >
      <span className="col-span-1 rounded-sm opacity-75" style={{ background: surface }} />
      <span className="col-span-2 rounded-sm" style={{ background: surface }} />
    </span>
  )
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
    <section className="space-y-3 py-3">
      <div>
        <p className="text-[13px] text-foreground">{t("settings.appearance.themeLibrary")}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {t("settings.appearance.themeLibraryHint")}
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {BUILTIN_THEMES.map((theme) => (
          <button
            key={theme.id}
            type="button"
            onClick={() => onSelect(theme.id)}
            className={cn(
              "flex items-center gap-2 rounded-md border p-2 text-left transition-colors hover:bg-card",
              selected.id === theme.id ? "border-primary ring-1 ring-primary" : "border-border",
            )}
          >
            <ThemePreview theme={theme} />
            <span className="min-w-0 text-[12px] text-foreground">
              {builtinThemeName(theme, t)}
            </span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
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
      {error && <p className="text-[11px] text-destructive">{error}</p>}

      {themes.length > 0 && (
        <div className="space-y-1 rounded-md border border-border p-2">
          <p className="px-1 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {t("settings.appearance.importedThemes")}
          </p>
          {themes.map((theme) => (
            <div key={theme.id} className="flex items-center gap-2 rounded px-1 py-1">
              <button
                type="button"
                className="min-w-0 flex flex-1 items-center gap-2 text-left"
                onClick={() => onSelect(theme.id)}
              >
                <ThemePreview theme={theme} />
                <span className="min-w-0">
                  <span className="block truncate text-[12px] text-foreground">{theme.name}</span>
                  {theme.author && (
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {t("settings.appearance.themeAuthor", { author: theme.author })}
                    </span>
                  )}
                </span>
              </button>
              <button
                type="button"
                className="rounded p-1 text-muted-foreground hover:bg-card hover:text-foreground"
                title={t("settings.appearance.exportTheme")}
                onClick={() => void exportTheme(theme)}
              >
                <Download className="size-3.5" />
              </button>
              <button
                type="button"
                className="rounded p-1 text-muted-foreground hover:bg-card hover:text-destructive"
                title={t("settings.appearance.removeTheme")}
                onClick={() => void removeTheme(theme)}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

const themeActionClass =
  "inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] text-foreground transition-colors hover:bg-card"

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

function ShortcutsTab() {
  const { t } = useTranslation()
  const modifier =
    typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "⌘" : "Ctrl"
  const shortcuts = [
    ["settings.shortcuts.quickOpen", `${modifier} P`],
    ["settings.shortcuts.search", `${modifier} Shift F`],
    ["settings.shortcuts.newNote", `${modifier} N`],
    ["settings.shortcuts.toggleLeftSidebar", `${modifier} B`],
    ["settings.shortcuts.toggleRightSidebar", `${modifier} Shift B`],
    ["settings.shortcuts.settings", `${modifier} ,`],
    ["settings.shortcuts.back", `${modifier} [`],
    ["settings.shortcuts.forward", `${modifier} ]`],
  ] as const
  const treeShortcuts = [
    ["settings.shortcuts.treeNavigation", "↑ ↓ ← →  Home  End"],
    ["settings.shortcuts.treeOpen", "Enter  Space"],
    ["settings.shortcuts.treeRename", "F2"],
    ["settings.shortcuts.treeMenu", "Menu  Shift F10"],
  ] as const

  const ShortcutList = ({ entries }: { entries: readonly (readonly [string, string])[] }) => (
    <div className="divide-y divide-border rounded-lg border border-border">
      {entries.map(([label, keys]) => (
        <div key={label} className="flex items-center justify-between gap-4 px-3 py-2.5">
          <span className="text-[13px] text-foreground">{t(label)}</span>
          <kbd className="shrink-0 rounded border border-border bg-card px-2 py-1 font-mono text-[11px] text-muted-foreground">
            {keys}
          </kbd>
        </div>
      ))}
    </div>
  )

  return (
    <div className="flex flex-col gap-5 py-1">
      <p className="text-[12px] text-muted-foreground">{t("settings.shortcuts.description")}</p>
      <ShortcutList entries={shortcuts} />
      <div>
        <h3 className="mb-2 text-[13px] font-medium text-foreground">
          {t("settings.shortcuts.treeTitle")}
        </h3>
        <ShortcutList entries={treeShortcuts} />
      </div>
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
    void saveSettingsPatch({ ai: next }).catch(() => {})
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
