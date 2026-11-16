import * as React from "react"
import { toCanonicalModuleId } from "@/lib/modules"
import { installCatalogModule } from "@/lib/modules/package-manager/catalog-install"
import { reportInstallFailure } from "@/lib/modules/package-manager/install-errors"
import type { ModuleDef } from "../modules"

export interface PresetInstallTarget {
  presetId: string
  presetLabel: string
  missingModules: ModuleDef[]
}

interface ModuleInstallFlowOptions {
  /** Canonical ids of the modules that are installed right now. */
  installedModuleIds: Set<string>
  setInstalledModuleIds: React.Dispatch<React.SetStateAction<Set<string>>>
  /** Switches the preset on once everything it needs is installed. */
  applyPreset: (presetId: string) => Promise<void>
  /** Switches one module on or off once it is installed. */
  applyModuleToggle: (moduleId: string, enabled: boolean) => Promise<void>
}

/**
 * The "download what is missing" dialogs of the module list: one module that a person switches
 * on (`askToInstall`) and the modules a chosen preset needs (`askToInstallForPreset`). It owns
 * the dialogs' state, the progress and the failure text; the module list owns what is installed
 * and what gets switched on afterwards.
 */
export function useModuleInstallFlow({
  installedModuleIds,
  setInstalledModuleIds,
  applyPreset,
  applyModuleToggle,
}: ModuleInstallFlowOptions) {
  const [notInstalledModalOpen, setNotInstalledModalOpen] = React.useState(false)
  const [pendingInstallModule, setPendingInstallModule] = React.useState<ModuleDef | null>(null)
  const [isInstallingPending, setIsInstallingPending] = React.useState(false)
  // Why the last download in an open dialog failed: the text of its code, shown under the buttons.
  const [installError, setInstallError] = React.useState<string | null>(null)

  const [missingPresetModalOpen, setMissingPresetModalOpen] = React.useState(false)
  const [pendingPresetTarget, setPendingPresetTarget] = React.useState<PresetInstallTarget | null>(
    null,
  )
  const [isDownloadingMissing, setIsDownloadingMissing] = React.useState(false)
  const [downloadProgress, setDownloadProgress] = React.useState<{
    current: number
    total: number
  } | null>(null)

  /** Whether a module is installed (the module list's guard before switching it on). */
  const isInstalled = (moduleId: string) => installedModuleIds.has(toCanonicalModuleId(moduleId))

  const askToInstall = (mod: ModuleDef) => {
    setInstallError(null)
    setPendingInstallModule(mod)
    setNotInstalledModalOpen(true)
  }

  const cancelInstall = () => {
    setNotInstalledModalOpen(false)
    setPendingInstallModule(null)
  }

  const askToInstallForPreset = (target: PresetInstallTarget) => {
    setInstallError(null)
    setPendingPresetTarget(target)
    setMissingPresetModalOpen(true)
  }

  const cancelPresetInstall = () => {
    setMissingPresetModalOpen(false)
    setPendingPresetTarget(null)
  }

  /** The missing-modules dialog cannot be closed while it downloads. */
  const onMissingPresetOpenChange = (open: boolean) => {
    if (isDownloadingMissing) return
    setMissingPresetModalOpen(open)
    if (!open) setPendingPresetTarget(null)
  }

  const downloadAndEnablePending = async () => {
    if (!pendingInstallModule) return
    setIsInstallingPending(true)
    setInstallError(null)
    const canonicalId = toCanonicalModuleId(pendingInstallModule.id)

    try {
      const { result } = await installCatalogModule(canonicalId)
      if (!result.success) {
        setInstallError(reportInstallFailure(result.errorCode, result.error))
        return
      }

      setInstalledModuleIds((prev) => new Set([...prev, canonicalId]))
      setNotInstalledModalOpen(false)
      void applyModuleToggle(pendingInstallModule.id, true)
      setPendingInstallModule(null)
    } catch (err) {
      setInstallError(reportInstallFailure(err))
    } finally {
      setIsInstallingPending(false)
    }
  }

  const downloadAllMissing = async () => {
    if (!pendingPresetTarget) return
    setIsDownloadingMissing(true)
    setInstallError(null)
    const { presetId, missingModules } = pendingPresetTarget
    const newlyInstalledIds: string[] = []

    try {
      for (let i = 0; i < missingModules.length; i++) {
        const mod = missingModules[i]
        setDownloadProgress({ current: i + 1, total: missingModules.length })

        const canonicalId = toCanonicalModuleId(mod.id)
        const { result } = await installCatalogModule(canonicalId)
        if (!result.success) {
          setInstallError(reportInstallFailure(result.errorCode, result.error))
          return
        }
        newlyInstalledIds.push(canonicalId)
      }

      setInstalledModuleIds((prev) => new Set([...prev, ...newlyInstalledIds]))
      setMissingPresetModalOpen(false)
      setPendingPresetTarget(null)
      await applyPreset(presetId)
    } catch (err) {
      setInstallError(reportInstallFailure(err))
    } finally {
      // What was installed before a failure stays installed, so the list shows it.
      if (newlyInstalledIds.length > 0) {
        setInstalledModuleIds((prev) => new Set([...prev, ...newlyInstalledIds]))
      }
      setIsDownloadingMissing(false)
      setDownloadProgress(null)
    }
  }

  return {
    notInstalledModalOpen,
    setNotInstalledModalOpen,
    pendingInstallModule,
    isInstallingPending,
    installError,
    missingPresetModalOpen,
    onMissingPresetOpenChange,
    pendingPresetTarget,
    isDownloadingMissing,
    downloadProgress,
    isInstalled,
    askToInstall,
    cancelInstall,
    askToInstallForPreset,
    cancelPresetInstall,
    downloadAndEnablePending,
    downloadAllMissing,
  }
}
