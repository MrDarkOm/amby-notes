"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  Blocks,
  Bot,
  Check,
  Clock3,
  Cloud,
  Database,
  Download,
  GitBranch,
  Layout,
  Loader2,
  PenTool,
  Pencil,
  Plus,
  Star,
  Tags,
  Trash2,
} from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import {
  STANDARD_MODULES,
  toCanonicalModuleId,
  toShortModuleId,
  type ProfileId,
} from "@/lib/modules"
import {
  DEFAULT_AI,
  loadSettings,
  loadWorkspaceConfig,
  saveSettingsPatch,
  saveWorkspaceConfigPatch,
  type AiSettings,
} from "../app-config"
import { ModelsManager } from "../models-manager"
import { isModuleAvailable, MODULE_REGISTRY, type ModuleDef } from "../modules"
import { useSettingsStore } from "../use-settings-store"
import { CreativeSettings } from "../creative/creative-settings"
import { Row } from "./settings-common"
import { ModulePackageManager } from "./settings-package-manager"
import type { Preset } from "../presets"
import { loadGlobalModulesRegistry } from "@/lib/modules/global-registry"
import { getCatalogModule } from "@/lib/modules/package-manager/catalog"
import { installFromRemoteUrl } from "@/lib/modules/package-manager/installer"

const MODULE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  tags: Tags,
  favorites: Star,
  databases: Database,
  history: Clock3,
  links: GitBranch,
  graph: GitBranch,
  sync: Cloud,
  ai: Bot,
  excalidraw: PenTool,
  canvas: Layout,
}

export function ModuleMessage({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-5 py-8 text-center">
      <p className="text-[13px] font-medium text-foreground">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-[11px] leading-5 text-muted-foreground">
        {description}
      </p>
    </div>
  )
}

export function HistorySettings() {
  const { t, i18n } = useTranslation()
  const [maxCopies, setMaxCopies] = React.useState(20)
  const [maxAgeDays, setMaxAgeDays] = React.useState(30)
  const [autoPrune, setAutoPrune] = React.useState(false)
  const [enabled, setEnabled] = React.useState(true)
  const [isPruning, setIsPruning] = React.useState(false)
  const [notice, setNotice] = React.useState("")

  React.useEffect(() => {
    let mounted = true
    loadWorkspaceConfig()
      .then((cfg) => {
        if (!mounted) return
        const historySettings = (cfg?.moduleSettings?.history as Record<string, unknown>) ?? {}
        if (typeof historySettings.maxCopies === "number") {
          setMaxCopies(historySettings.maxCopies)
        } else {
          const lsCopies = Number(localStorage.getItem("amby:history-max-copies"))
          if (lsCopies) setMaxCopies(lsCopies)
        }
        if (typeof historySettings.maxAgeDays === "number") {
          setMaxAgeDays(historySettings.maxAgeDays)
        }
        if (typeof historySettings.autoPrune === "boolean") {
          setAutoPrune(historySettings.autoPrune)
        }
        if (typeof historySettings.enabled === "boolean") {
          setEnabled(historySettings.enabled)
        } else {
          setEnabled(localStorage.getItem("amby:history-disabled") !== "true")
        }
      })
      .catch(() => {})
    return () => {
      mounted = false
    }
  }, [])

  const persistSettings = async (next: {
    enabled?: boolean
    maxCopies?: number
    maxAgeDays?: number
    autoPrune?: boolean
  }) => {
    try {
      const cfg = await loadWorkspaceConfig()
      const existingHistory = (cfg?.moduleSettings?.history as Record<string, unknown>) ?? {}
      const updatedHistory = {
        ...existingHistory,
        enabled: next.enabled ?? enabled,
        maxCopies: next.maxCopies ?? maxCopies,
        maxAgeDays: next.maxAgeDays ?? maxAgeDays,
        autoPrune: next.autoPrune ?? autoPrune,
      }
      await saveWorkspaceConfigPatch({
        moduleSettings: {
          ...(cfg?.moduleSettings ?? {}),
          history: updatedHistory,
        },
      })
    } catch (err) {
      console.error("Failed to save history settings to workspace.json:", err)
    }
  }

  const handlePruneNow = async () => {
    setIsPruning(true)
    setNotice("")
    try {
      const { cleanupHistory } = await import("@/lib/storage")
      const { formatHistorySize } = await import("../history/history-model")
      const res = await cleanupHistory({
        maxSnapshotsPerNote: maxCopies,
        maxAgeDays: maxAgeDays === 0 ? null : maxAgeDays,
      })
      if (res.removedCount > 0) {
        setNotice(
          t("settings.history.prunedNotice", {
            count: res.removedCount,
            size: formatHistorySize(res.freedBytes, i18n.language),
          }),
        )
      } else {
        setNotice(t("settings.history.nothingToPrune"))
      }
    } catch (err) {
      setNotice(String(err))
    } finally {
      setIsPruning(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="divide-y divide-border rounded-lg border border-border">
        <Row label={t("settings.history.enabled")} hint={t("settings.history.enabledHint")}>
          <Switch
            checked={enabled}
            onCheckedChange={(value) => {
              setEnabled(value)
              localStorage.setItem("amby:history-disabled", String(!value))
              void persistSettings({ enabled: value })
              window.dispatchEvent(new Event("amby:history-setting-change"))
            }}
          />
        </Row>
        <Row label={t("settings.history.autoPrune")} hint={t("settings.history.autoPruneHint")}>
          <Switch
            checked={autoPrune}
            disabled={!enabled}
            onCheckedChange={(value) => {
              setAutoPrune(value)
              void persistSettings({ autoPrune: value })
            }}
          />
        </Row>
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
              void persistSettings({ maxCopies: value })
            }}
            className="h-8 w-24 rounded-md border border-border bg-card px-2 text-right text-[13px]"
          />
        </Row>
        <Row label={t("settings.history.maxAgeDays")} hint={t("settings.history.maxAgeDaysHint")}>
          <input
            type="number"
            min={0}
            max={3650}
            value={maxAgeDays}
            disabled={!enabled}
            onChange={(e) => {
              const value = Math.max(0, Number(e.target.value) || 0)
              setMaxAgeDays(value)
              void persistSettings({ maxAgeDays: value })
            }}
            className="h-8 w-24 rounded-md border border-border bg-card px-2 text-right text-[13px]"
          />
        </Row>
        <Row label={t("settings.history.clear")}>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!enabled || isPruning}
              onClick={() => void handlePruneNow()}
            >
              {t("settings.history.pruneAction")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.dispatchEvent(new Event("amby:history-clear-all"))}
            >
              {t("settings.history.clearAction")}
            </Button>
          </div>
        </Row>
      </div>
      {notice ? (
        <div className="rounded-md bg-muted/50 px-3 py-2 text-[12px] text-muted-foreground">
          {notice}
        </div>
      ) : null}
    </div>
  )
}

export function AiTab() {
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

export interface ModulesTabProps {
  activeModules: string[]
  onModuleEnabledChange: (id: string, enabled: boolean) => void
  selectedId: string
  onSelectedChange: (id: string) => void
}

export function ModulesTab({
  activeModules,
  onModuleEnabledChange,
  selectedId,
  onSelectedChange,
}: ModulesTabProps) {
  const { t } = useTranslation()
  const experimental = useSettingsStore((state) => state.experimental)
  const selected = MODULE_REGISTRY.find((module) => module.id === selectedId) ?? MODULE_REGISTRY[0]

  const [activePresetId, setActivePresetId] = React.useState<string>("standard")
  const [customPresets, setCustomPresets] = React.useState<Preset[]>([])
  const [installedModuleIds, setInstalledModuleIds] = React.useState<Set<string>>(new Set())
  const [isRegistryLoaded, setIsRegistryLoaded] = React.useState(false)

  // Modal dialog states
  const [lockedModalOpen, setLockedModalOpen] = React.useState(false)
  const [deleteLockedModalOpen, setDeleteLockedModalOpen] = React.useState(false)
  const [pendingToggle, setPendingToggle] = React.useState<{
    moduleId: string
    targetEnabled: boolean
  } | null>(null)

  const [notInstalledModalOpen, setNotInstalledModalOpen] = React.useState(false)
  const [pendingInstallModule, setPendingInstallModule] = React.useState<ModuleDef | null>(null)
  const [isInstallingPending, setIsInstallingPending] = React.useState(false)

  const [missingPresetModalOpen, setMissingPresetModalOpen] = React.useState(false)
  const [pendingPresetTarget, setPendingPresetTarget] = React.useState<{
    presetId: string
    presetLabel: string
    missingModules: ModuleDef[]
  } | null>(null)
  const [isDownloadingMissing, setIsDownloadingMissing] = React.useState(false)
  const [downloadProgress, setDownloadProgress] = React.useState<{
    current: number
    total: number
  } | null>(null)

  const [createPresetModalOpen, setCreatePresetModalOpen] = React.useState(false)
  const [newPresetName, setNewPresetName] = React.useState("")

  const [renameModalOpen, setRenameModalOpen] = React.useState(false)
  const [presetToRename, setPresetToRename] = React.useState<Preset | null>(null)
  const [renamePresetName, setRenamePresetName] = React.useState("")

  const [deleteModalOpen, setDeleteModalOpen] = React.useState(false)
  const [presetToDelete, setPresetToDelete] = React.useState<Preset | null>(null)

  React.useEffect(() => {
    let mounted = true
    loadWorkspaceConfig()
      .then((cfg) => {
        if (!mounted) return
        const presetsList =
          cfg?.customPresets && Array.isArray(cfg.customPresets) ? cfg.customPresets : []
        setCustomPresets(presetsList)

        const savedId = cfg?.layout?.activePresetId
        if (savedId === "minimal" || savedId === "simple") {
          setActivePresetId("minimal")
        } else if (savedId === "standard") {
          setActivePresetId("standard")
        } else if (savedId && presetsList.some((p) => p.id === savedId)) {
          setActivePresetId(savedId)
        } else if (cfg?.profile?.id === "minimal") {
          setActivePresetId("minimal")
        } else if (cfg?.profile?.id === "standard") {
          setActivePresetId("standard")
        } else if (cfg?.profile?.id === "custom" && presetsList.length > 0) {
          setActivePresetId(presetsList[0].id)
        } else {
          setActivePresetId(
            activeModules.length === 0
              ? "minimal"
              : activeModules.length === STANDARD_MODULES.length &&
                  activeModules.every((id) => STANDARD_MODULES.includes(toCanonicalModuleId(id)))
                ? "standard"
                : (presetsList[0]?.id ?? "standard"),
          )
        }
      })
      .catch(() => {})

    loadGlobalModulesRegistry()
      .then((reg) => {
        if (mounted) {
          setInstalledModuleIds(new Set(Object.keys(reg.installed)))
          setIsRegistryLoaded(true)
        }
      })
      .catch(() => {})

    return () => {
      mounted = false
    }
  }, [])

  if (!selected) return null

  const isSelectedEnabled = activeModules.some(
    (id) => toShortModuleId(id) === toShortModuleId(selected.id),
  )

  const applyPreset = async (presetId: string) => {
    setActivePresetId(presetId)

    if (presetId === "minimal") {
      await saveWorkspaceConfigPatch({
        profile: { id: "minimal" as ProfileId },
        layout: {
          activePresetId: "minimal",
          activeModules: [],
          buttons: null,
          activeBySide: null,
        },
      })
      for (const modId of activeModules) {
        onModuleEnabledChange(toShortModuleId(modId), false)
      }
    } else if (presetId === "standard") {
      await saveWorkspaceConfigPatch({
        profile: { id: "standard" as ProfileId },
        layout: {
          activePresetId: "standard",
          activeModules: [...STANDARD_MODULES],
          buttons: null,
          activeBySide: null,
        },
      })
      for (const mod of MODULE_REGISTRY) {
        const shouldEnable = STANDARD_MODULES.includes(toCanonicalModuleId(mod.id))
        const isCurrentEnabled = activeModules.some(
          (m) => toShortModuleId(m) === toShortModuleId(mod.id),
        )
        if (isCurrentEnabled !== shouldEnable) {
          onModuleEnabledChange(toShortModuleId(mod.id), shouldEnable)
        }
      }
    } else {
      const custom = customPresets.find((p) => p.id === presetId)
      if (custom) {
        const shortCustom = custom.activeModules.map(toShortModuleId)
        const canonicalCustom = custom.activeModules.map(toCanonicalModuleId)

        await saveWorkspaceConfigPatch({
          profile: { id: "custom" as ProfileId },
          enabledModules: canonicalCustom,
          layout: {
            activePresetId: presetId,
            activeModules: canonicalCustom,
            buttons: null,
            activeBySide: null,
          },
        })
        for (const mod of MODULE_REGISTRY) {
          const shouldEnable = shortCustom.includes(toShortModuleId(mod.id))
          const isCurrentEnabled = activeModules.some(
            (m) => toShortModuleId(m) === toShortModuleId(mod.id),
          )
          if (isCurrentEnabled !== shouldEnable) {
            onModuleEnabledChange(toShortModuleId(mod.id), shouldEnable)
          }
        }
      }
    }
  }

  const handleSelectPreset = async (presetId: string) => {
    let currentInstalled = installedModuleIds
    if (!isRegistryLoaded) {
      try {
        const reg = await loadGlobalModulesRegistry()
        currentInstalled = new Set(Object.keys(reg.installed))
        setInstalledModuleIds(currentInstalled)
        setIsRegistryLoaded(true)
      } catch {
        // fallback to current state
      }
    }

    let targetCanonicalIds: string[] = []
    let presetLabel = ""

    if (presetId === "minimal") {
      targetCanonicalIds = []
      presetLabel = t("profiles.minimal")
    } else if (presetId === "standard") {
      targetCanonicalIds = STANDARD_MODULES
      presetLabel = t("profiles.standard")
    } else {
      const custom = customPresets.find((p) => p.id === presetId)
      if (custom) {
        targetCanonicalIds = custom.activeModules.map(toCanonicalModuleId)
        presetLabel = custom.label || custom.id
      }
    }

    const missingDefs = targetCanonicalIds
      .filter((id) => !currentInstalled.has(id))
      .map((id) => MODULE_REGISTRY.find((m) => toCanonicalModuleId(m.id) === id))
      .filter((m): m is ModuleDef => Boolean(m))

    if (missingDefs.length > 0) {
      setPendingPresetTarget({
        presetId,
        presetLabel,
        missingModules: missingDefs,
      })
      setMissingPresetModalOpen(true)
      return
    }

    await applyPreset(presetId)
  }

  const handleDownloadAllMissing = async () => {
    if (!pendingPresetTarget) return
    setIsDownloadingMissing(true)
    const { presetId, missingModules } = pendingPresetTarget
    const newlyInstalledIds: string[] = []

    try {
      for (let i = 0; i < missingModules.length; i++) {
        const mod = missingModules[i]
        setDownloadProgress({ current: i + 1, total: missingModules.length })

        const canonicalId = toCanonicalModuleId(mod.id)
        const catalogEntry = await getCatalogModule(canonicalId)
        const targetVersion = catalogEntry?.latestVersion ?? "1.0.0"
        const url =
          catalogEntry?.versions[targetVersion]?.downloadUrl ??
          `https://github.com/MrDarkOm/amby-notes/releases/download/v0.1.4/${canonicalId}-${targetVersion}.amby-pkg`

        const result = await installFromRemoteUrl(url)
        if (!result.success) {
          throw new Error(result.error ?? `Failed to download ${canonicalId}`)
        }
        newlyInstalledIds.push(canonicalId)
      }

      setInstalledModuleIds((prev) => new Set([...prev, ...newlyInstalledIds]))
      setMissingPresetModalOpen(false)
      setPendingPresetTarget(null)
      await applyPreset(presetId)
    } catch (err) {
      console.error("Failed to download missing preset modules:", err)
      if (newlyInstalledIds.length > 0) {
        setInstalledModuleIds((prev) => new Set([...prev, ...newlyInstalledIds]))
      }
    } finally {
      setIsDownloadingMissing(false)
      setDownloadProgress(null)
    }
  }

  const handleApplyActualToggle = async (modId: string, nextEnabled: boolean) => {
    const shortId = toShortModuleId(modId)
    onModuleEnabledChange(shortId, nextEnabled)

    const nextModules = nextEnabled
      ? Array.from(new Set([...activeModules.map(toShortModuleId), shortId]))
      : activeModules.map(toShortModuleId).filter((id) => id !== shortId)

    if (activePresetId !== "minimal" && activePresetId !== "standard") {
      const updated = customPresets.map((p) =>
        p.id === activePresetId
          ? {
              ...p,
              activeModules: nextEnabled
                ? Array.from(new Set([...p.activeModules.map(toShortModuleId), shortId]))
                : p.activeModules.map(toShortModuleId).filter((id) => id !== shortId),
            }
          : p,
      )
      setCustomPresets(updated)
      await saveWorkspaceConfigPatch({
        customPresets: updated,
        enabledModules: nextModules.map(toCanonicalModuleId),
      })
    }
  }

  const handleAttemptToggle = (mod: ModuleDef, nextEnabled: boolean) => {
    // 1. Guard for locked built-in presets (Minimal and Standard)
    if (activePresetId === "minimal" || activePresetId === "standard") {
      setPendingToggle({ moduleId: mod.id, targetEnabled: nextEnabled })
      setLockedModalOpen(true)
      return
    }

    // 2. Guard for uninstalled modules when enabling
    const canonicalId = toCanonicalModuleId(mod.id)
    if (nextEnabled && !installedModuleIds.has(canonicalId)) {
      setPendingInstallModule(mod)
      setNotInstalledModalOpen(true)
      return
    }

    // 3. Normal toggle
    void handleApplyActualToggle(mod.id, nextEnabled)
  }

  const handleCreateCustomFromLocked = async () => {
    if (!pendingToggle) {
      setLockedModalOpen(false)
      return
    }

    const shortModId = toShortModuleId(pendingToggle.moduleId)
    const baseModules = (
      activePresetId === "minimal"
        ? []
        : activeModules.length > 0
          ? activeModules
          : STANDARD_MODULES
    ).map(toShortModuleId)

    const nextModules = pendingToggle.targetEnabled
      ? Array.from(new Set([...baseModules, shortModId]))
      : baseModules.filter((id) => id !== shortModId)

    const newPreset: Preset = {
      id: `custom-${Date.now()}`,
      label: t("settings.modules.newPresetDefaultName"),
      builtin: false,
      locked: false,
      activeModules: nextModules,
      layout: [],
      activeBySide: { left: "files", right: null },
    }

    const updated = [...customPresets, newPreset]
    setCustomPresets(updated)
    setActivePresetId(newPreset.id)
    setLockedModalOpen(false)

    await saveWorkspaceConfigPatch({
      customPresets: updated,
      profile: { id: "custom" as ProfileId },
      enabledModules: nextModules.map(toCanonicalModuleId),
      layout: {
        activePresetId: newPreset.id,
        activeModules: nextModules.map(toCanonicalModuleId),
        buttons: null,
        activeBySide: null,
      },
    })

    onModuleEnabledChange(shortModId, pendingToggle.targetEnabled)
    setPendingToggle(null)
  }

  const handleCreateCustomForDelete = async () => {
    setDeleteLockedModalOpen(false)

    const baseModules = (
      activePresetId === "minimal"
        ? []
        : activeModules.length > 0
          ? activeModules
          : STANDARD_MODULES
    ).map(toShortModuleId)

    const newPreset: Preset = {
      id: `custom-${Date.now()}`,
      label: t("settings.modules.newPresetDefaultName"),
      builtin: false,
      locked: false,
      activeModules: [...baseModules],
      layout: [],
      activeBySide: { left: "files", right: null },
    }

    const updated = [...customPresets, newPreset]
    setCustomPresets(updated)
    setActivePresetId(newPreset.id)

    await saveWorkspaceConfigPatch({
      customPresets: updated,
      profile: { id: "custom" as ProfileId },
      enabledModules: baseModules.map(toCanonicalModuleId),
      layout: {
        activePresetId: newPreset.id,
        activeModules: baseModules.map(toCanonicalModuleId),
        buttons: null,
        activeBySide: null,
      },
    })
  }

  const handleDownloadAndEnablePending = async () => {
    if (!pendingInstallModule) return
    setIsInstallingPending(true)
    const canonicalId = toCanonicalModuleId(pendingInstallModule.id)

    try {
      const catalogEntry = await getCatalogModule(canonicalId)
      const targetVersion = catalogEntry?.latestVersion ?? "1.0.0"
      const url =
        catalogEntry?.versions[targetVersion]?.downloadUrl ??
        `https://github.com/MrDarkOm/amby-notes/releases/download/v0.1.4/${canonicalId}-${targetVersion}.amby-pkg`

      const result = await installFromRemoteUrl(url)
      if (!result.success) {
        throw new Error(result.error ?? "Failed to download module")
      }

      setInstalledModuleIds((prev) => new Set([...prev, canonicalId]))
      setNotInstalledModalOpen(false)
      void handleApplyActualToggle(pendingInstallModule.id, true)
    } catch (err) {
      console.error("Failed to download and enable module:", err)
    } finally {
      setIsInstallingPending(false)
      setPendingInstallModule(null)
    }
  }

  const handleCreateNewPreset = async () => {
    const trimmed = newPresetName.trim() || t("settings.modules.newPresetDefaultName")
    const currentShort = activeModules.map(toShortModuleId)
    const newPreset: Preset = {
      id: `custom-${Date.now()}`,
      label: trimmed,
      builtin: false,
      locked: false,
      activeModules: [...currentShort],
      layout: [],
      activeBySide: { left: "files", right: null },
    }

    const updated = [...customPresets, newPreset]
    setCustomPresets(updated)
    setActivePresetId(newPreset.id)
    setCreatePresetModalOpen(false)
    setNewPresetName("")

    await saveWorkspaceConfigPatch({
      customPresets: updated,
      profile: { id: "custom" as ProfileId },
      layout: {
        activePresetId: newPreset.id,
        activeModules: currentShort.map(toCanonicalModuleId),
        buttons: null,
        activeBySide: null,
      },
    })
  }

  const handleSaveRenamePreset = async () => {
    if (!presetToRename) return
    const trimmed = renamePresetName.trim() || presetToRename.label || ""
    const updated = customPresets.map((p) =>
      p.id === presetToRename.id ? { ...p, label: trimmed } : p,
    )
    setCustomPresets(updated)
    setRenameModalOpen(false)
    setPresetToRename(null)

    await saveWorkspaceConfigPatch({ customPresets: updated })
  }

  const handleDeletePreset = async () => {
    if (!presetToDelete) return
    const updated = customPresets.filter((p) => p.id !== presetToDelete.id)
    setCustomPresets(updated)
    setDeleteModalOpen(false)

    if (activePresetId === presetToDelete.id) {
      await applyPreset("standard")
    } else {
      await saveWorkspaceConfigPatch({ customPresets: updated })
    }

    setPresetToDelete(null)
  }

  return (
    <div className="flex min-h-full flex-col">
      {/* Module Presets bar */}
      <div className="border-b border-border bg-card/30 p-4">
        <div className="mb-2.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {t("settings.modules.presetsTitle")}
        </div>

        <div className="flex flex-wrap items-stretch gap-2.5">
          {/* Minimal preset */}
          <button
            type="button"
            onClick={() => void handleSelectPreset("minimal")}
            className={cn(
              "flex min-w-[150px] max-w-[220px] flex-1 flex-col justify-between rounded-lg border p-3 text-left",
              activePresetId === "minimal"
                ? "border-primary bg-primary/5 text-foreground ring-1 ring-primary"
                : "border-border bg-card text-muted-foreground hover:border-border/80 hover:bg-accent/40",
            )}
          >
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-foreground">
                  {t("profiles.minimal")}
                </span>
                {activePresetId === "minimal" && <Check className="size-3.5 text-primary" />}
              </div>
              <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                {t("profiles.descriptions.minimal")}
              </p>
            </div>
          </button>

          {/* Standard preset */}
          <button
            type="button"
            onClick={() => void handleSelectPreset("standard")}
            className={cn(
              "flex min-w-[150px] max-w-[220px] flex-1 flex-col justify-between rounded-lg border p-3 text-left",
              activePresetId === "standard"
                ? "border-primary bg-primary/5 text-foreground ring-1 ring-primary"
                : "border-border bg-card text-muted-foreground hover:border-border/80 hover:bg-accent/40",
            )}
          >
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-foreground">
                  {t("profiles.standard")}
                </span>
                {activePresetId === "standard" && <Check className="size-3.5 text-primary" />}
              </div>
              <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                {t("profiles.descriptions.standard")}
              </p>
            </div>
          </button>

          {/* User custom presets */}
          {customPresets.map((preset) => {
            const isSelected = activePresetId === preset.id
            return (
              <div
                key={preset.id}
                onClick={() => void handleSelectPreset(preset.id)}
                className={cn(
                  "group relative flex min-w-[150px] max-w-[220px] flex-1 cursor-pointer flex-col justify-between rounded-lg border p-3 text-left",
                  isSelected
                    ? "border-primary bg-primary/5 text-foreground ring-1 ring-primary"
                    : "border-border bg-card text-muted-foreground hover:border-border/80 hover:bg-accent/40",
                )}
              >
                <div>
                  <div className="flex items-center justify-between">
                    <span className="truncate text-xs font-semibold text-foreground">
                      {preset.label || preset.id}
                    </span>
                    <div className="flex items-center gap-1">
                      {isSelected && <Check className="size-3.5 text-primary shrink-0" />}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          setPresetToRename(preset)
                          setRenamePresetName(preset.label || "")
                          setRenameModalOpen(true)
                        }}
                        className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                        title={t("settings.modules.renamePreset")}
                      >
                        <Pencil className="size-3" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          setPresetToDelete(preset)
                          setDeleteModalOpen(true)
                        }}
                        className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        title={t("settings.modules.deletePreset")}
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </div>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {t("settings.modules.modulesCount", { count: preset.activeModules.length })}
                  </p>
                </div>
              </div>
            )
          })}

          {/* Create Preset + Button */}
          <button
            type="button"
            onClick={() => {
              setNewPresetName("")
              setCreatePresetModalOpen(true)
            }}
            className="flex min-w-[120px] items-center justify-center gap-1.5 rounded-lg border border-dashed border-border px-3.5 py-3 text-xs font-medium text-muted-foreground hover:border-primary/60 hover:text-foreground"
          >
            <Plus className="size-3.5" />
            <span>{t("settings.modules.createPreset")}</span>
          </button>
        </div>
      </div>

      {/* Main body: Catalogue on left, Details on right */}
      <div className="grid flex-1 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="border-b border-border p-2 lg:border-b-0 lg:border-r">
          <div className="mb-1 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {t("settings.modules.catalogue")}
          </div>
          <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-1">
            {MODULE_REGISTRY.map((module) => {
              const Icon = MODULE_ICONS[module.id] ?? Blocks
              const isEnabled = activeModules.some(
                (id) => toShortModuleId(id) === toShortModuleId(module.id),
              )
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
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left"
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-foreground">
                        {t(module.labelKey)}
                      </span>
                    </span>
                  </button>
                  <Switch
                    className="mr-2"
                    checked={isEnabled}
                    disabled={!isAvailable && !isEnabled}
                    onCheckedChange={(next) => handleAttemptToggle(module, next)}
                    aria-label={t(module.labelKey)}
                  />
                </div>
              )
            })}
          </div>
        </aside>

        <section className="flex min-w-0 flex-col px-5 py-5 sm:px-7">
          <div className="min-h-[260px] flex-1 pb-6">
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
            ) : !isSelectedEnabled ? (
              <ModuleMessage
                title={t("settings.modules.disabledTitle")}
                description={t("settings.modules.disabledDescription")}
              />
            ) : selected.id === "ai" ? (
              <AiTab />
            ) : selected.id === "history" ? (
              <HistorySettings />
            ) : selected.id === "creative" ? (
              <CreativeSettings />
            ) : (
              <ModuleMessage
                title={t("settings.modules.readyTitle")}
                description={t("settings.modules.noSettings")}
              />
            )}
          </div>

          <div className="mb-4">
            <ModulePackageManager
              moduleId={selected.id}
              moduleName={t(selected.labelKey)}
              canDelete={activePresetId !== "minimal" && activePresetId !== "standard"}
              onAttemptDeleteLocked={() => setDeleteLockedModalOpen(true)}
              onModuleChange={() => {
                void loadGlobalModulesRegistry().then((reg) => {
                  setInstalledModuleIds(new Set(Object.keys(reg.installed)))
                })
              }}
              onModuleUninstall={(uninstalledId) => {
                const shortId = toShortModuleId(uninstalledId)
                const canonicalId = toCanonicalModuleId(uninstalledId)

                // 1. Immediately disable module in workspace and activeModules
                onModuleEnabledChange(shortId, false)

                // 2. Remove from installedModuleIds
                setInstalledModuleIds((prev) => {
                  const next = new Set(prev)
                  next.delete(canonicalId)
                  return next
                })

                // 3. If in a custom preset, also remove this module from preset's activeModules
                if (activePresetId !== "minimal" && activePresetId !== "standard") {
                  setCustomPresets((prev) => {
                    const updated = prev.map((p) =>
                      p.id === activePresetId
                        ? {
                            ...p,
                            activeModules: p.activeModules.filter(
                              (id) => toShortModuleId(id) !== shortId,
                            ),
                          }
                        : p,
                    )
                    const nextActive = activeModules
                      .filter((id) => toShortModuleId(id) !== shortId)
                      .map(toCanonicalModuleId)
                    void saveWorkspaceConfigPatch({
                      customPresets: updated,
                      enabledModules: nextActive,
                    })
                    return updated
                  })
                }
              }}
            />
          </div>
        </section>
      </div>

      {/* Dialog 0: Built-in Preset Delete Locked Notice */}
      <Dialog open={deleteLockedModalOpen} onOpenChange={setDeleteLockedModalOpen}>
        <DialogContent className="max-w-md border-border bg-card p-5">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">
              {t("settings.modules.builtinPresetDeleteLockedTitle")}
            </DialogTitle>
            <DialogDescription className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              {t("settings.modules.builtinPresetDeleteLockedDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setDeleteLockedModalOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button size="sm" onClick={() => void handleCreateCustomForDelete()}>
              {t("settings.modules.createCustomPresetAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog 1: Built-in Preset Locked Notice */}
      <Dialog open={lockedModalOpen} onOpenChange={setLockedModalOpen}>
        <DialogContent className="max-w-md border-border bg-card p-5">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">
              {t("settings.modules.builtinPresetLockedTitle")}
            </DialogTitle>
            <DialogDescription className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              {t("settings.modules.builtinPresetLockedDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4 flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setLockedModalOpen(false)
                setPendingToggle(null)
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button size="sm" onClick={() => void handleCreateCustomFromLocked()}>
              {t("settings.modules.createCustomPresetAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog 2: Module Not Installed Notice */}
      <Dialog open={notInstalledModalOpen} onOpenChange={setNotInstalledModalOpen}>
        <DialogContent className="max-w-md border-border bg-card p-5">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">
              {t("settings.modules.moduleNotInstalledTitle")}
            </DialogTitle>
            <DialogDescription className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              {t("settings.modules.moduleNotInstalledDescription", {
                name: pendingInstallModule ? t(pendingInstallModule.labelKey) : "",
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4 flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setNotInstalledModalOpen(false)
                setPendingInstallModule(null)
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              disabled={isInstallingPending}
              onClick={() => void handleDownloadAndEnablePending()}
            >
              {t("settings.modules.downloadAndEnableAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog 3: Create Custom Preset */}
      <Dialog open={createPresetModalOpen} onOpenChange={setCreatePresetModalOpen}>
        <DialogContent className="max-w-md border-border bg-card p-5">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">
              {t("settings.modules.createPreset")}
            </DialogTitle>
            <DialogDescription className="mt-1.5 text-xs text-muted-foreground">
              {t("settings.modules.newPresetPrompt")}
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <input
              type="text"
              value={newPresetName}
              onChange={(e) => setNewPresetName(e.target.value)}
              placeholder={t("settings.modules.newPresetDefaultName")}
              className="h-8 w-full rounded-md border border-border bg-card px-2.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreateNewPreset()
              }}
            />
          </div>
          <DialogFooter className="mt-4 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setCreatePresetModalOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button size="sm" onClick={() => void handleCreateNewPreset()}>
              {t("common.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog 4: Rename Preset */}
      <Dialog open={renameModalOpen} onOpenChange={setRenameModalOpen}>
        <DialogContent className="max-w-md border-border bg-card p-5">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">
              {t("settings.modules.renamePreset")}
            </DialogTitle>
            <DialogDescription className="mt-1.5 text-xs text-muted-foreground">
              {t("settings.modules.renamePresetPrompt")}
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <input
              type="text"
              value={renamePresetName}
              onChange={(e) => setRenamePresetName(e.target.value)}
              className="h-8 w-full rounded-md border border-border bg-card px-2.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSaveRenamePreset()
              }}
            />
          </div>
          <DialogFooter className="mt-4 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setRenameModalOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button size="sm" onClick={() => void handleSaveRenamePreset()}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog 5: Delete Preset Confirm */}
      <Dialog open={deleteModalOpen} onOpenChange={setDeleteModalOpen}>
        <DialogContent className="max-w-md border-border bg-card p-5">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">
              {t("settings.modules.deletePreset")}
            </DialogTitle>
            <DialogDescription className="mt-1.5 text-xs text-muted-foreground">
              {t("settings.modules.deletePresetConfirm", {
                name: presetToDelete?.label || presetToDelete?.id,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setDeleteModalOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void handleDeletePreset()}>
              {t("settings.modules.deletePreset")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog 6: Missing Preset Modules Dialog */}
      <Dialog
        open={missingPresetModalOpen}
        onOpenChange={(open) => {
          if (!isDownloadingMissing) {
            setMissingPresetModalOpen(open)
            if (!open) {
              setPendingPresetTarget(null)
            }
          }
        }}
      >
        <DialogContent className="max-w-md border-border bg-card p-5">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">
              {t("settings.modules.presetMissingModulesTitle")}
            </DialogTitle>
            <DialogDescription className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              {t("settings.modules.presetMissingModulesDesc", {
                name: pendingPresetTarget?.presetLabel ?? "",
              })}
            </DialogDescription>
          </DialogHeader>

          {/* List of missing modules */}
          <div className="my-3 max-h-56 space-y-1.5 overflow-y-auto rounded-lg border border-border bg-muted/20 p-2">
            {pendingPresetTarget?.missingModules.map((mod) => {
              const Icon = MODULE_ICONS[mod.id] ?? Blocks
              return (
                <div
                  key={mod.id}
                  className="flex items-center gap-2.5 rounded-md border border-border/50 bg-card/60 px-2.5 py-1.5 text-xs"
                >
                  <Icon className="size-4 shrink-0 text-primary" />
                  <span className="font-medium text-foreground">{t(mod.labelKey)}</span>
                </div>
              )
            })}
          </div>

          {/* Download progress if active */}
          {isDownloadingMissing && downloadProgress && (
            <div className="flex items-center gap-2 rounded-md bg-primary/10 px-3 py-2 text-xs text-primary">
              <Loader2 className="size-4 shrink-0" />
              <span>
                {t("settings.modules.downloadingModulesProgress", {
                  current: downloadProgress.current,
                  total: downloadProgress.total,
                })}
              </span>
            </div>
          )}

          <DialogFooter className="mt-4 flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={isDownloadingMissing}
              onClick={() => {
                setMissingPresetModalOpen(false)
                setPendingPresetTarget(null)
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              disabled={isDownloadingMissing}
              onClick={() => void handleDownloadAllMissing()}
            >
              {isDownloadingMissing ? (
                <>
                  <Loader2 className="mr-1.5 size-3.5" />
                  <span>{t("settings.modules.packages.downloading")}</span>
                </>
              ) : (
                <>
                  <Download className="mr-1.5 size-3.5" />
                  <span>{t("settings.modules.downloadAllAction")}</span>
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
