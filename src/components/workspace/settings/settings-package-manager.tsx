"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  AlertCircle,
  CheckCircle2,
  Download,
  HardDrive,
  Loader2,
  RefreshCw,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  getModuleUsage,
  installFromRemoteUrl,
  installPackage,
  rollbackModule,
  uninstallModule,
} from "@/lib/modules/package-manager/installer"
import { getCatalogModule } from "@/lib/modules/package-manager/catalog"
import { loadGlobalModulesRegistry } from "@/lib/modules/global-registry"
import { toCanonicalModuleId } from "@/lib/modules/types"

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

export interface ModulePackageManagerProps {
  moduleId: string
  moduleName: string
  canDelete?: boolean
  onAttemptDeleteLocked?: () => void
  onModuleChange?: () => void
  onModuleUninstall?: (moduleId: string) => void
}

export function ModulePackageManager({
  moduleId,
  moduleName,
  canDelete = true,
  onAttemptDeleteLocked,
  onModuleChange,
  onModuleUninstall,
}: ModulePackageManagerProps) {
  const { t } = useTranslation()
  const canonicalId = toCanonicalModuleId(moduleId)

  const [isLoading, setIsLoading] = React.useState(true)
  const [isProcessing, setIsProcessing] = React.useState(false)
  const [isCheckingUpdates, setIsCheckingUpdates] = React.useState(false)
  const [activeVersion, setActiveVersion] = React.useState<string>("1.0.0")
  const [installedSize, setInstalledSize] = React.useState<number>(0)
  const [installedVersions, setInstalledVersions] = React.useState<string[]>([])
  const [isInstalled, setIsInstalled] = React.useState(true)
  const [updateDialogOpen, setUpdateDialogOpen] = React.useState(false)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = React.useState(false)
  const [pendingUpdateVersion, setPendingUpdateVersion] = React.useState<string | null>(null)
  const [statusMessage, setStatusMessage] = React.useState<{
    type: "success" | "error"
    text: string
  } | null>(null)

  const fileInputRef = React.useRef<HTMLInputElement | null>(null)

  const refreshModuleInfo = React.useCallback(async () => {
    setIsLoading(true)
    try {
      const usage = await getModuleUsage(canonicalId)
      setActiveVersion(usage.activeVersion)
      setInstalledSize(usage.installedSize)
      setInstalledVersions(usage.installedVersions)

      const registry = await loadGlobalModulesRegistry()
      const installed = registry.installed[canonicalId]
      const installedStatus = Boolean(
        installed && installed.activeVersion && installed.activeVersion !== "none",
      )
      setIsInstalled(installedStatus)
    } catch (err) {
      console.error("Failed to load module usage:", err)
    } finally {
      setIsLoading(false)
    }
  }, [canonicalId])

  React.useEffect(() => {
    void refreshModuleInfo()
    setStatusMessage(null)
  }, [refreshModuleInfo])

  const handleDownloadLatest = async () => {
    setIsProcessing(true)
    setStatusMessage(null)
    try {
      const catalogEntry = await getCatalogModule(canonicalId)
      const targetVersion = catalogEntry?.latestVersion ?? "1.0.0"
      const url =
        catalogEntry?.versions[targetVersion]?.downloadUrl ??
        `https://github.com/MrDarkOm/amby-notes/releases/download/v0.1.4/${canonicalId}-${targetVersion}.amby-pkg`

      const result = await installFromRemoteUrl(url)

      if (result.success) {
        setStatusMessage({
          type: "success",
          text: t("settings.modules.packages.installSuccess", {
            name: moduleName,
            version: result.installedVersion ?? targetVersion,
          }),
        })
        await refreshModuleInfo()
        onModuleChange?.()
      } else {
        setStatusMessage({
          type: "error",
          text: t("settings.modules.packages.installError", {
            error: result.error ?? result.errorCode ?? "Failed",
          }),
        })
      }
    } catch (err) {
      setStatusMessage({
        type: "error",
        text: t("settings.modules.packages.installError", {
          error: err instanceof Error ? err.message : String(err),
        }),
      })
    } finally {
      setIsProcessing(false)
    }
  }

  const handleCheckUpdates = async () => {
    setIsCheckingUpdates(true)
    setStatusMessage(null)
    try {
      const catalogEntry = await getCatalogModule(canonicalId)
      const latestVer = catalogEntry?.latestVersion ?? "1.0.0"

      if (!isInstalled) {
        setPendingUpdateVersion(latestVer)
        setUpdateDialogOpen(true)
      } else if (latestVer !== activeVersion && latestVer > activeVersion) {
        setPendingUpdateVersion(latestVer)
        setUpdateDialogOpen(true)
      } else {
        setStatusMessage({
          type: "success",
          text: t("settings.modules.upToDate"),
        })
      }
    } catch (err) {
      setStatusMessage({
        type: "error",
        text: String(err),
      })
    } finally {
      setIsCheckingUpdates(false)
    }
  }

  const handleApplyUpdate = async () => {
    setUpdateDialogOpen(false)
    await handleDownloadLatest()
  }

  const handleRollback = async () => {
    if (installedVersions.length <= 1) return
    setIsProcessing(true)
    setStatusMessage(null)
    try {
      const result = await rollbackModule(canonicalId)
      if (result.success) {
        setStatusMessage({
          type: "success",
          text: t("settings.modules.packages.rollbackSuccess", {
            version: result.installedVersion,
          }),
        })
        await refreshModuleInfo()
        onModuleChange?.()
      } else {
        setStatusMessage({
          type: "error",
          text: result.error ?? t("settings.modules.packages.installError", { error: "Unknown" }),
        })
      }
    } catch (err) {
      setStatusMessage({
        type: "error",
        text: String(err),
      })
    } finally {
      setIsProcessing(false)
    }
  }

  const handleUninstall = async () => {
    setIsProcessing(true)
    setStatusMessage(null)
    try {
      const result = await uninstallModule(canonicalId)
      if (result.success) {
        setStatusMessage({
          type: "success",
          text: t("settings.modules.packages.uninstallSuccess"),
        })
        onModuleUninstall?.(canonicalId)
        await refreshModuleInfo()
        onModuleChange?.()
      } else {
        setStatusMessage({
          type: "error",
          text: result.error ?? t("settings.modules.packages.installError", { error: "Unknown" }),
        })
      }
    } catch (err) {
      setStatusMessage({
        type: "error",
        text: String(err),
      })
    } finally {
      setIsProcessing(false)
    }
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setIsProcessing(true)
    setStatusMessage(null)

    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as Record<string, unknown>

      let manifest: unknown
      let files: Record<string, string> = {}

      if (parsed && typeof parsed === "object") {
        if ("manifest" in parsed && "files" in parsed) {
          manifest = parsed.manifest
          files = (parsed.files as Record<string, string>) || {}
        } else if ("id" in parsed && "version" in parsed) {
          manifest = parsed
          files = {}
        }
      }

      if (!manifest) {
        throw new Error("Invalid package format: manifest missing")
      }

      const result = await installPackage(manifest, files)
      if (result.success) {
        setStatusMessage({
          type: "success",
          text: t("settings.modules.packages.installSuccess", {
            name: moduleName,
            version: result.installedVersion,
          }),
        })
        await refreshModuleInfo()
        onModuleChange?.()
      } else {
        setStatusMessage({
          type: "error",
          text: t("settings.modules.packages.installError", {
            error: result.error ?? result.errorCode ?? "Validation failed",
          }),
        })
      }
    } catch (err) {
      setStatusMessage({
        type: "error",
        text: t("settings.modules.packages.installError", {
          error: err instanceof Error ? err.message : String(err),
        }),
      })
    } finally {
      setIsProcessing(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ""
      }
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card/40 p-3">
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,.amby-pkg"
        className="hidden"
        onChange={(e) => void handleFileChange(e)}
      />

      {/* Top action row: 3 compact icon buttons */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Button 1: Download or Delete */}
          {isInstalled ? (
            <Button
              variant="outline"
              size="icon"
              className="size-8 text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={isProcessing || isLoading}
              title={t("settings.modules.packages.uninstall")}
              onClick={() => {
                if (canDelete === false) {
                  onAttemptDeleteLocked?.()
                } else {
                  setConfirmDeleteOpen(true)
                }
              }}
            >
              {isProcessing ? <Loader2 className="size-4" /> : <Trash2 className="size-4" />}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="icon"
              className="size-8 text-primary hover:bg-primary/10 hover:text-primary"
              disabled={isProcessing || isLoading}
              title={t("settings.modules.packages.downloadAction")}
              onClick={() => void handleDownloadLatest()}
            >
              {isProcessing ? <Loader2 className="size-4" /> : <Download className="size-4" />}
            </Button>
          )}

          {/* Button 2: Install from file */}
          <Button
            variant="outline"
            size="icon"
            className="size-8 text-muted-foreground hover:text-foreground"
            disabled={isProcessing || isLoading}
            title={t("settings.modules.packages.installFromFile")}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="size-4" />
          </Button>

          {/* Button 3: File size */}
          <div
            className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 text-xs text-muted-foreground"
            title={t("settings.modules.fileSize")}
          >
            <HardDrive className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="font-mono text-[11px]">
              {isLoading ? "…" : formatBytes(installedSize)}
            </span>
          </div>
        </div>

        {/* Rollback button if multiple versions are available */}
        {installedVersions.length > 1 && (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground hover:text-foreground"
            disabled={isProcessing}
            title={t("settings.modules.packages.rollback")}
            onClick={() => void handleRollback()}
          >
            <RotateCcw className="size-4" />
          </Button>
        )}
      </div>

      {/* Version and update check row */}
      <div className="mt-3 flex items-center justify-between border-t border-border/50 pt-2.5">
        <span className="text-xs text-muted-foreground">
          {isLoading
            ? "…"
            : isInstalled
              ? t("settings.modules.installedVersion", { version: activeVersion })
              : t("settings.modules.notInstalled")}
        </span>

        <Button
          variant="outline"
          size="sm"
          disabled={isProcessing || isCheckingUpdates || isLoading}
          onClick={() => void handleCheckUpdates()}
          className="h-7 text-xs"
        >
          {isCheckingUpdates ? (
            <Loader2 className="mr-1.5 size-3" />
          ) : (
            <RefreshCw className="mr-1.5 size-3" />
          )}
          {isCheckingUpdates
            ? t("settings.modules.checkingUpdates")
            : t("settings.modules.checkUpdates")}
        </Button>
      </div>

      {/* Status message */}
      {statusMessage && (
        <div
          className={`mt-3 flex items-start gap-2 rounded-md p-2 text-xs ${
            statusMessage.type === "success"
              ? "border border-green-500/20 bg-green-500/10 text-green-600 dark:text-green-400"
              : "border border-destructive/20 bg-destructive/10 text-destructive"
          }`}
        >
          {statusMessage.type === "success" ? (
            <CheckCircle2 className="size-4 shrink-0" />
          ) : (
            <AlertCircle className="size-4 shrink-0" />
          )}
          <span className="leading-snug">{statusMessage.text}</span>
        </div>
      )}

      {/* Update Available Dialog */}
      <Dialog open={updateDialogOpen} onOpenChange={setUpdateDialogOpen}>
        <DialogContent className="max-w-md border-border bg-card p-5">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">
              {t("settings.modules.updateAvailableTitle")}
            </DialogTitle>
            <DialogDescription className="mt-1.5 text-xs text-muted-foreground">
              {t("settings.modules.updateAvailableDescription", {
                name: moduleName,
                version: pendingUpdateVersion ?? "latest",
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setUpdateDialogOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button size="sm" disabled={isProcessing} onClick={() => void handleApplyUpdate()}>
              {t("settings.modules.updateAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* Delete confirmation dialog */}
      <Dialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <DialogContent className="max-w-md border-border bg-card p-5">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">
              {t("settings.modules.deleteModuleTitle")}
            </DialogTitle>
            <DialogDescription className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              {t("settings.modules.deleteModuleConfirm", { name: moduleName })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfirmDeleteOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={isProcessing}
              onClick={() => {
                setConfirmDeleteOpen(false)
                void handleUninstall()
              }}
            >
              {t("settings.modules.deleteModuleAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
