"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { Check, FolderOpen, RotateCcw, Trash2 } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { openInExplorer, isTauri } from "@/lib/storage"
import { useSettingsStore } from "./use-settings-store"
import { useVaultStore } from "./use-vault-store"
import { ModelsManager } from "./models-manager"
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

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
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

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t } = useTranslation()
  const prefs = useSettingsStore((s) => s.prefs)
  const setPrefs = useSettingsStore((s) => s.setPrefs)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-4 border-border bg-background sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-foreground">{t("settings.title")}</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="appearance" className="min-h-0 flex-1">
          <TabsList className="bg-card">
            <TabsTrigger value="appearance">{t("settings.tabs.appearance")}</TabsTrigger>
            <TabsTrigger value="editor">{t("settings.tabs.editor")}</TabsTrigger>
            <TabsTrigger value="ai">{t("settings.tabs.ai")}</TabsTrigger>
            <TabsTrigger value="startup">{t("settings.tabs.startup")}</TabsTrigger>
            <TabsTrigger value="data">{t("settings.tabs.data")}</TabsTrigger>
          </TabsList>

          <div className="mt-2 max-h-[55vh] min-h-[280px] overflow-y-auto pr-1">
            {/* ── Appearance ───────────────────────────────────────────── */}
            <TabsContent value="appearance" className="divide-y divide-border">
              <Row label={t("settings.appearance.theme")}>
                <Select value={prefs.theme} onValueChange={(v) => setPrefs({ theme: v as ThemePref })}>
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
                        "flex size-6 items-center justify-center rounded-full ring-2 ring-offset-2 ring-offset-[#0a0a0a] transition-all",
                        prefs.accent === a ? "ring-white/80" : "ring-transparent hover:ring-white/30",
                      )}
                    >
                      {prefs.accent === a && <Check className="size-3.5 text-white" />}
                    </button>
                  ))}
                </div>
              </Row>

              <Row label={t("settings.appearance.fontScale")}>
                <Select value={prefs.fontScale} onValueChange={(v) => setPrefs({ fontScale: v as FontScale })}>
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

              <Row label={t("settings.appearance.density")}>
                <Select value={prefs.density} onValueChange={(v) => setPrefs({ density: v as Density })}>
                  <SelectTrigger className={selectTrigger}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="comfortable">{t("settings.appearance.comfortable")}</SelectItem>
                    <SelectItem value="compact">{t("settings.appearance.compact")}</SelectItem>
                  </SelectContent>
                </Select>
              </Row>

              <Row label={t("settings.appearance.language")}>
                <Select value={prefs.language} onValueChange={(v) => setPrefs({ language: v as Language })}>
                  <SelectTrigger className={selectTrigger}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ru">Русский</SelectItem>
                    <SelectItem value="en">English</SelectItem>
                  </SelectContent>
                </Select>
              </Row>
            </TabsContent>

            {/* ── Editor ───────────────────────────────────────────────── */}
            <TabsContent value="editor" className="divide-y divide-border">
              <Row label={t("settings.editor.defaultViewMode")}>
                <Select
                  value={prefs.editor.defaultViewMode}
                  onValueChange={(v) => setPrefs({ editor: { ...prefs.editor, defaultViewMode: v as ViewModePref } })}
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
                  onValueChange={(v) => setPrefs({ editor: { ...prefs.editor, contentWidth: v as ContentWidth } })}
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

            {/* ── AI ───────────────────────────────────────────────────── */}
            <TabsContent value="ai" className="flex h-full min-h-0 flex-col">
              <p className="px-1 pb-2 text-[12px] text-muted-foreground">{t("settings.ai.desc")}</p>
              <AiTab />
            </TabsContent>

            {/* ── Startup ──────────────────────────────────────────────── */}
            <TabsContent value="startup" className="divide-y divide-border">
              <Row label={t("settings.startup.reopenLastVault")}>
                <Switch
                  checked={prefs.startup.reopenLastVault}
                  onCheckedChange={(c) => setPrefs({ startup: { ...prefs.startup, reopenLastVault: c } })}
                />
              </Row>
              <Row label={t("settings.startup.restoreSession")}>
                <Switch
                  checked={prefs.startup.restoreSession}
                  onCheckedChange={(c) => setPrefs({ startup: { ...prefs.startup, restoreSession: c } })}
                />
              </Row>
            </TabsContent>

            {/* ── Data ─────────────────────────────────────────────────── */}
            <TabsContent value="data">
              <DataTab />
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

// ── AI tab: shares the model library with the AI panel ────────────────────────

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
            <button type="button" className={btn} onClick={() => void openInExplorer(dir)} disabled={!dir}>
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
          onClick={() => {
            if (confirm(t("settings.data.resetConfirm"))) setPrefs({ ...DEFAULT_PREFS })
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
