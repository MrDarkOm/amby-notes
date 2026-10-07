"use client"

import { AmbySelect } from "@/components/ui/amby-select"
import * as React from "react"
import { useTranslation } from "react-i18next"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  Activity,
  Bug,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CirclePause,
  CirclePlay,
  Download,
  FileClock,
  FileText,
  Gauge,
  HardDrive,
  RefreshCw,
  Trash2,
} from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { exportTextFile, confirmAction, isTauri } from "@/lib/storage"
import { flushLogs } from "@/lib/logger"
import { createDebugReport } from "@/lib/debug/report"
import { cn } from "@/lib/utils"
import { useDebugStore } from "./use-debug-store"
import {
  durationStats,
  filterDebugEvents,
  groupRepeatedErrors,
  type DebugEventFilters,
} from "./debug-session"
import type { LogEntry } from "@/lib/logger"
import { eventLabelKey } from "./event-presentation"

interface LogViewerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const DEFAULT_FILTERS: DebugEventFilters = {
  query: "",
  level: "all",
  source: "all",
  subsystem: "",
  operationId: "",
  windowId: "",
  since: "",
  until: "",
}

function toLocalDateTime(value: string): string {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function safeMetadata(metadata: Record<string, unknown> | undefined): string {
  if (!metadata) return ""
  try {
    return JSON.stringify(metadata, null, 2).slice(0, 8_000)
  } catch {
    return "{}"
  }
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="amby-debug-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function EventRow({ entry, repeat }: { entry: LogEntry; repeat?: number }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = React.useState(false)
  const hasMetadata = Boolean(entry.metadata && Object.keys(entry.metadata).length)
  return (
    <div className={cn("amby-debug-event", `is-${entry.level}`)}>
      <button
        className="amby-debug-event-head"
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown /> : <ChevronRight />}
        <time>{new Date(entry.timestamp).toLocaleTimeString()}</time>
        <span className="amby-debug-level">
          {t(`settings.debug.logLevel${entry.level[0].toUpperCase()}${entry.level.slice(1)}`)}
        </span>
        <span className="amby-debug-source">
          {t(
            entry.source === "frontend"
              ? "settings.debug.sourceFrontend"
              : "settings.debug.sourceBackend",
          )}
        </span>
        {entry.subsystem && <span className="amby-debug-subsystem">{entry.subsystem}</span>}
        <strong>{t(eventLabelKey(entry.event, entry.level))}</strong>
        {typeof entry.durationMs === "number" && (
          <span>{t("settings.debug.durationValue", { value: entry.durationMs.toFixed(1) })}</span>
        )}
        {repeat && repeat > 1 && <span className="amby-debug-repeat">×{repeat}</span>}
      </button>
      {expanded && (
        <div className="amby-debug-event-details">
          <div>
            <span>
              {t("settings.debug.eventCodeLabel")}: {entry.event}
            </span>
          </div>
          <div>
            {entry.operationId && (
              <span>
                {t("settings.debug.operationLabel")}: {entry.operationId}
              </span>
            )}
          </div>
          <div>
            {entry.windowId && (
              <span>
                {t("settings.debug.windowLabel")}: {entry.windowId}
              </span>
            )}
          </div>
          {hasMetadata && <pre className="select-text">{safeMetadata(entry.metadata)}</pre>}
        </div>
      )}
    </div>
  )
}

export function LogViewerDialog({ open, onOpenChange }: LogViewerDialogProps) {
  const { t } = useTranslation()
  const store = useDebugStore()
  const hydrate = useDebugStore((state) => state.hydrate)
  const [filters, setFilters] = React.useState(DEFAULT_FILTERS)
  const [groupErrors, setGroupErrors] = React.useState(true)
  const [errorOnly, setErrorOnly] = React.useState(false)
  const [activeTab, setActiveTab] = React.useState("overview")
  const [userDescription, setUserDescription] = React.useState("")
  const [reportPreview, setReportPreview] = React.useState("")
  const [reportPreviewOpen, setReportPreviewOpen] = React.useState(false)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [scrollElement, setScrollElement] = React.useState<HTMLDivElement | null>(null)
  React.useEffect(() => {
    if (open) {
      void hydrate()
      setActiveTab("overview")
    }
  }, [open, hydrate])

  const filtered = React.useMemo(
    () =>
      filterDebugEvents(store.events, { ...filters, level: errorOnly ? "error" : filters.level }),
    [store.events, filters, errorOnly],
  )
  const displayed = React.useMemo(() => {
    if (!groupErrors) return filtered.map((event) => ({ event, count: 1 }))
    return groupRepeatedErrors(filtered.filter((event) => event.level === "error"))
      .concat(
        filtered.filter((event) => event.level !== "error").map((event) => ({ event, count: 1 })),
      )
      .sort((a, b) => Date.parse(a.event.timestamp) - Date.parse(b.event.timestamp))
  }, [filtered, groupErrors])
  const eventVirtualizer = useVirtualizer({
    count: displayed.length,
    enabled: open && activeTab === "logs" && scrollElement !== null,
    getItemKey: (index) => displayed[index].event.id,
    getScrollElement: () => scrollElement,
    estimateSize: () => 42,
    overscan: 16,
  })
  React.useEffect(() => {
    if (!open || activeTab !== "logs" || !scrollElement) return
    const frame = requestAnimationFrame(() => eventVirtualizer.measure())
    return () => cancelAnimationFrame(frame)
  }, [activeTab, displayed.length, eventVirtualizer, open, scrollElement])
  const stats = React.useMemo(() => durationStats(store.events), [store.events])
  const slowEvents = React.useMemo(
    () =>
      [...store.events]
        .filter((event) => typeof event.durationMs === "number")
        .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
        .slice(0, 20),
    [store.events],
  )
  const durationValue = (value: number) =>
    stats.count
      ? t("settings.debug.durationValue", { value: value.toFixed(1) })
      : t("settings.debug.notMeasured")
  const status = store.status
  const backend = status.backend
  const errorCount = store.events.filter((event) => event.level === "error").length

  const updateFilter = <K extends keyof DebugEventFilters>(key: K, value: DebugEventFilters[K]) => {
    if (key === "level") setErrorOnly(false)
    setFilters((previous) => ({ ...previous, [key]: value }))
  }

  const startProblemCapture = () => {
    if (store.recording && !store.recording.endedAt) {
      setActiveTab("report")
      return
    }
    setReportPreview("")
    setReportPreviewOpen(false)
    store.startRecording()
    setActiveTab("report")
  }

  const withErrorHandling = async (action: () => Promise<unknown>, success?: string) => {
    setActionError(null)
    setNotice(null)
    try {
      const result = await action()
      if (success && result !== null) setNotice(success)
    } catch {
      setActionError(t("settings.debug.actionFailed"))
    }
  }

  const createReport = () => {
    if (!store.health) {
      setActionError(t("settings.debug.healthUnavailable"))
      return
    }
    setActionError(null)
    setReportPreview(
      createDebugReport({
        events: store.recording ? store.recordingEvents : store.events,
        health: store.health,
        recording: store.recording,
        userDescription: userDescription.trim() || undefined,
      }),
    )
    setReportPreviewOpen(true)
  }

  const addMarker = () => {
    store.addMarker("issue_observed")
  }

  const exportCurrentReport = () =>
    withErrorHandling(async () => {
      if (!reportPreview) throw new Error(t("settings.debug.previewFirst"))
      await flushLogs()
      return await exportTextFile(
        reportPreview,
        `amby-debug-report-${new Date().toISOString().slice(0, 10)}.json`,
      )
    }, t("settings.debug.reportExported"))

  const deletePersisted = async () => {
    if (!(await confirmAction(t("settings.debug.deletePersistedConfirm")))) return
    await withErrorHandling(async () => {
      await store.deletePersistedHistory()
    }, t("settings.debug.persistedDeleted"))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="amby-debug-dialog flex h-[88vh] max-h-[850px] w-[94vw] max-w-5xl sm:max-w-none flex-col gap-0 overflow-hidden p-0"
      >
        <div className="amby-debug-header">
          <div>
            <DialogTitle className="flex items-center gap-2 text-base font-semibold">
              <Bug className="size-4" />
              {t("settings.debug.viewerTitle")}
            </DialogTitle>
            <p>{t("settings.debug.viewerSubtitle")}</p>
          </div>
        </div>

        {(actionError || store.error || status.transportError || backend?.fileError || notice) && (
          <div className={cn("amby-debug-alert", notice && "is-success")} role="status">
            {notice ?? actionError ?? store.error ?? status.transportError ?? backend?.fileError}
          </div>
        )}
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="amby-debug-tabs min-h-0 flex-1"
        >
          <TabsList className="amby-debug-tab-list">
            <TabsTrigger value="overview">
              <span className="flex items-center gap-1.5 font-medium">
                <Activity className="size-3.5" />
                {t("settings.debug.overview")}
              </span>
              <small>{t("settings.debug.overviewPurpose")}</small>
            </TabsTrigger>
            <TabsTrigger value="logs">
              <span className="flex items-center gap-1.5 font-medium">
                <Bug className="size-3.5" />
                {t("settings.debug.logs")}
                {errorCount > 0 && (
                  <span className="ml-1 rounded-full bg-destructive/15 px-1.5 py-0.5 text-[10px] font-semibold text-destructive">
                    {errorCount}
                  </span>
                )}
              </span>
              <small>{t("settings.debug.logsPurpose")}</small>
            </TabsTrigger>
            <TabsTrigger value="report">
              <span className="flex items-center gap-1.5 font-medium">
                <FileClock className="size-3.5" />
                {t("settings.debug.report")}
                {store.recording && !store.recording.endedAt && (
                  <span className="ml-1 size-2 rounded-full bg-purple-500" />
                )}
              </span>
              <small>{t("settings.debug.reportPurpose")}</small>
            </TabsTrigger>
            <TabsTrigger value="performance">
              <span className="flex items-center gap-1.5 font-medium">
                <Gauge className="size-3.5" />
                {t("settings.debug.performance")}
              </span>
              <small>{t("settings.debug.performancePurpose")}</small>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="amby-debug-pane space-y-4">
            <div
              className={cn("amby-debug-status-banner", errorCount > 0 ? "is-error" : "is-healthy")}
            >
              <div className="flex items-center gap-3">
                {errorCount > 0 ? (
                  <CircleAlert className="size-5 shrink-0 text-destructive" />
                ) : (
                  <CheckCircle2 className="size-5 shrink-0 text-emerald-500" />
                )}
                <div>
                  <h3 className="text-sm font-semibold">
                    {errorCount > 0
                      ? t("settings.debug.dashboardErrors", { count: errorCount })
                      : t("settings.debug.dashboardHealthy")}
                  </h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {store.health
                      ? t("settings.debug.overviewWorkspace", {
                          open: store.health.documents.open,
                          dirty: store.health.documents.dirty,
                          conflicts: store.health.documents.conflicts,
                        })
                      : t("settings.debug.healthUnavailable")}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {errorCount > 0 && (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      setErrorOnly(true)
                      setActiveTab("logs")
                    }}
                  >
                    {t("settings.debug.openErrors", { count: errorCount })}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setErrorOnly(false)
                    setActiveTab("logs")
                  }}
                >
                  <Bug className="mr-1.5 size-3.5" />
                  {t("settings.debug.openJournal")}
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
              <div className="amby-debug-action-card">
                <div className="flex items-start gap-3">
                  <div className="shrink-0 rounded-lg bg-primary/10 p-2 text-primary">
                    <Bug className="size-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h4 className="text-sm font-semibold">{t("settings.debug.cardLogsTitle")}</h4>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {t("settings.debug.cardLogsDesc")}
                    </p>
                    <div className="mt-3 flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">
                        {t("settings.debug.filterSummary", {
                          shown: filtered.length,
                          total: store.events.length,
                        })}
                      </span>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setErrorOnly(false)
                          setActiveTab("logs")
                        }}
                      >
                        {t("settings.debug.cardLogsAction")} →
                      </Button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="amby-debug-action-card">
                <div className="flex items-start gap-3">
                  <div className="shrink-0 rounded-lg bg-purple-500/10 p-2 text-purple-400">
                    <FileClock className="size-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h4 className="text-sm font-semibold">{t("settings.debug.cardReportTitle")}</h4>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {t("settings.debug.cardReportDesc")}
                    </p>
                    <div className="mt-3 flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">
                        {store.recording && !store.recording.endedAt
                          ? t("settings.debug.recordingActive")
                          : t("settings.debug.stepRecordHint")}
                      </span>
                      <Button
                        variant="default"
                        size="sm"
                        onClick={startProblemCapture}
                        className="bg-purple-600 text-white hover:bg-purple-500"
                      >
                        {t("settings.debug.cardReportAction")} →
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="pt-2">
              <h4 className="mb-2.5 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                {t("settings.debug.technicalStatus")}
              </h4>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <div className="amby-debug-card">
                  <div className="mb-2.5 flex items-center gap-1.5 text-xs font-medium text-foreground">
                    <HardDrive className="size-3.5 text-muted-foreground" />
                    {t("settings.debug.storageBackendCard")}
                  </div>
                  <div className="space-y-2 text-xs">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t("settings.debug.vault")}:</span>
                      <span className="flex items-center gap-1.5 font-medium">
                        <span
                          className={cn(
                            "size-2 rounded-full",
                            backend?.vaultOpen ? "bg-emerald-500" : "bg-muted-foreground",
                          )}
                        />
                        {backend?.vaultOpen
                          ? t("settings.debug.vaultOpen")
                          : t("settings.debug.vaultClosed")}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t("settings.debug.watcher")}:</span>
                      <span className="flex items-center gap-1.5 font-medium">
                        <span
                          className={cn(
                            "size-2 rounded-full",
                            backend?.watcherRunning ? "bg-emerald-500" : "bg-muted-foreground",
                          )}
                        />
                        {backend?.watcherRunning
                          ? t("settings.debug.running")
                          : t("settings.debug.stopped")}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t("settings.debug.index")}:</span>
                      <span className="flex items-center gap-1.5 font-medium">
                        <span
                          className={cn(
                            "size-2 rounded-full",
                            backend?.indexReady ? "bg-emerald-500" : "bg-amber-500",
                          )}
                        />
                        {backend?.indexReady
                          ? t("settings.debug.ready")
                          : t("settings.debug.notReady")}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t("settings.debug.fileSize")}:</span>
                      <span className="font-mono text-[11px]">
                        {backend ? `${Math.round(backend.fileBytes / 1024)} KB` : "—"}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="amby-debug-card">
                  <div className="mb-2.5 flex items-center gap-1.5 text-xs font-medium text-foreground">
                    <FileText className="size-3.5 text-muted-foreground" />
                    {t("settings.debug.docsEditorCard")}
                  </div>
                  <div className="space-y-2 text-xs">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        {t("settings.debug.openDocuments")}:
                      </span>
                      <span className="font-medium">{store.health?.documents.open ?? 0}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        {t("settings.debug.dirtyDocuments")}:
                      </span>
                      <span
                        className={cn(
                          "font-medium",
                          (store.health?.documents.dirty ?? 0) > 0 &&
                            "font-semibold text-amber-400",
                        )}
                      >
                        {store.health?.documents.dirty ?? 0}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        {t("settings.debug.conflicts")}:
                      </span>
                      <span
                        className={cn(
                          "font-medium",
                          (store.health?.documents.conflicts ?? 0) > 0 &&
                            "font-semibold text-destructive",
                        )}
                      >
                        {store.health?.documents.conflicts ?? 0}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        {t("settings.debug.editorModes")}:
                      </span>
                      <span className="font-medium">
                        {store.health
                          ? `${store.health.documents.livePreview} Live / ${store.health.documents.source} Src`
                          : "—"}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="amby-debug-card">
                  <div className="mb-2.5 flex items-center gap-1.5 text-xs font-medium text-foreground">
                    <Gauge className="size-3.5 text-muted-foreground" />
                    {t("settings.debug.autosaveMemoryCard")}
                  </div>
                  <div className="space-y-2 text-xs">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        {t("settings.debug.autosavePending")}:
                      </span>
                      <span className="font-medium">
                        {store.health
                          ? store.health.autosave.scheduled + store.health.autosave.inFlight
                          : 0}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        {t("settings.debug.autosaveErrors")}:
                      </span>
                      <span
                        className={cn(
                          "font-medium",
                          (store.health?.autosave.errors ?? 0) > 0 &&
                            "font-semibold text-destructive",
                        )}
                      >
                        {store.health?.autosave.errors ?? 0}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        {t("settings.debug.eventsInMemory")}:
                      </span>
                      <span className="font-mono text-[11px]">{store.events.length}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        {t("settings.debug.enabledModules")}:
                      </span>
                      <span className="font-medium">
                        {store.health
                          ? `${store.health.modules.enabled}${store.health.modules.safeMode ? " (Safe)" : ""}`
                          : "—"}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {store.health && Object.keys(store.health.editorReasons).length > 0 && (
                <div className="amby-debug-editor-reasons mt-3">
                  <strong>{t("settings.debug.editorReasons")}</strong>
                  {Object.entries(store.health.editorReasons).map(([reason, count]) => (
                    <span key={reason}>
                      {t(`settings.debug.reason.${reason}`, { defaultValue: reason })}: {count}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent
            value="logs"
            className="amby-debug-pane amby-debug-pane--logs flex min-h-0 flex-col"
          >
            <div className="amby-debug-section-toolbar">
              <div>
                <h3>{t("settings.debug.logsHeading")}</h3>
                <p>
                  {t("settings.debug.filterSummary", {
                    shown: filtered.length,
                    total: store.events.length,
                  })}
                </p>
              </div>
              <div className="amby-debug-section-actions">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => store.setDisplayPaused(!store.displayPaused)}
                  aria-pressed={store.displayPaused}
                >
                  {store.displayPaused ? (
                    <CirclePlay className="size-3.5" />
                  ) : (
                    <CirclePause className="size-3.5" />
                  )}
                  {store.displayPaused
                    ? t("settings.debug.resumeDisplay")
                    : t("settings.debug.pauseDisplay")}
                </Button>
                <Button variant="outline" size="sm" onClick={store.clearScreen}>
                  <Trash2 className="size-3.5" /> {t("settings.debug.clearScreen")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void store.refresh()}
                  disabled={store.loading}
                >
                  <RefreshCw className="size-3.5" /> {t("settings.debug.refresh")}
                </Button>
              </div>
            </div>
            <div className="amby-debug-filters">
              <Input
                value={filters.query}
                onChange={(event) => updateFilter("query", event.target.value)}
                placeholder={t("settings.debug.searchPlaceholder")}
                aria-label={t("settings.debug.searchPlaceholder")}
              />
              <label className="amby-debug-error-filter">
                <input
                  type="checkbox"
                  checked={errorOnly}
                  onChange={(event) => setErrorOnly(event.target.checked)}
                />
                {t("settings.debug.errorsOnly", { count: errorCount })}
              </label>
            </div>
            <details className="amby-debug-disclosure">
              <summary>{t("settings.debug.moreFilters")}</summary>
              <div className="amby-debug-advanced-filters">
                <AmbySelect
                  size="sm"
                  className="w-32"
                  aria-label={t("settings.debug.levelAll")}
                  value={filters.level}
                  options={[
                    { value: "all", label: t("settings.debug.levelAll") },
                    ...(["debug", "info", "warn", "error"] as const).map((level) => ({
                      value: level,
                      label: t(`settings.debug.logLevel${level[0].toUpperCase()}${level.slice(1)}`),
                    })),
                  ]}
                  onValueChange={(next) =>
                    updateFilter("level", next as DebugEventFilters["level"])
                  }
                />
                <AmbySelect
                  size="sm"
                  className="w-36"
                  aria-label={t("settings.debug.sourceAll")}
                  value={filters.source}
                  options={[
                    { value: "all", label: t("settings.debug.sourceAll") },
                    { value: "frontend", label: t("settings.debug.sourceFrontend") },
                    { value: "backend", label: t("settings.debug.sourceBackend") },
                  ]}
                  onValueChange={(next) =>
                    updateFilter("source", next as DebugEventFilters["source"])
                  }
                />
                <Input
                  value={filters.subsystem}
                  onChange={(event) => updateFilter("subsystem", event.target.value)}
                  placeholder={t("settings.debug.subsystemFilter")}
                />
                <Input
                  value={filters.operationId}
                  onChange={(event) => updateFilter("operationId", event.target.value)}
                  placeholder={t("settings.debug.operationFilter")}
                />
                <Input
                  value={filters.windowId}
                  onChange={(event) => updateFilter("windowId", event.target.value)}
                  placeholder={t("settings.debug.windowFilter")}
                />
                <label>
                  {t("settings.debug.from")}
                  <input
                    type="datetime-local"
                    value={toLocalDateTime(filters.since)}
                    onChange={(event) =>
                      updateFilter(
                        "since",
                        event.target.value ? new Date(event.target.value).toISOString() : "",
                      )
                    }
                  />
                </label>
                <label>
                  {t("settings.debug.to")}
                  <input
                    type="datetime-local"
                    value={toLocalDateTime(filters.until)}
                    onChange={(event) =>
                      updateFilter(
                        "until",
                        event.target.value ? new Date(event.target.value).toISOString() : "",
                      )
                    }
                  />
                </label>
                <label className="amby-debug-checkbox">
                  <input
                    type="checkbox"
                    checked={groupErrors}
                    onChange={(event) => setGroupErrors(event.target.checked)}
                  />
                  {t("settings.debug.groupRepeated")}
                </label>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void store.refresh()}
                  disabled={!isTauri() || store.loading}
                  title={!isTauri() ? t("settings.debug.nativeOnly") : undefined}
                >
                  {t("settings.debug.loadHistory")}
                </Button>
              </div>
              <div className="amby-debug-danger-action">
                <span>{t("settings.debug.deletePersistedHint")}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void deletePersisted()}
                  disabled={!isTauri()}
                  title={!isTauri() ? t("settings.debug.nativeOnly") : undefined}
                >
                  <FileClock className="size-3.5" /> {t("settings.debug.deletePersisted")}
                </Button>
              </div>
            </details>
            {store.displayPaused && (
              <div className="amby-debug-paused">{t("settings.debug.captureContinues")}</div>
            )}
            <div ref={setScrollElement} className="amby-debug-event-list">
              {displayed.length ? (
                <div style={{ height: eventVirtualizer.getTotalSize(), position: "relative" }}>
                  {eventVirtualizer.getVirtualItems().map((row) => (
                    <div
                      key={displayed[row.index].event.id}
                      ref={eventVirtualizer.measureElement}
                      data-index={row.index}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${row.start}px)`,
                      }}
                    >
                      <EventRow
                        entry={displayed[row.index].event}
                        repeat={displayed[row.index].count}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="amby-debug-empty">{t("settings.debug.noLogs")}</div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="performance" className="amby-debug-pane">
            <div className="amby-debug-card">
              <div className="flex items-center gap-2">
                <Activity className="size-4" />
                <h3>{t("settings.debug.durationTitle")}</h3>
              </div>
              <p className="text-xs text-muted-foreground">{t("settings.debug.performanceHint")}</p>
              <div className="amby-debug-stats-grid">
                <Stat label={t("settings.debug.durationCount")} value={stats.count} />
                <Stat label={t("settings.debug.average")} value={durationValue(stats.average)} />
              </div>
              <details className="amby-debug-disclosure">
                <summary>{t("settings.debug.moreMetrics")}</summary>
                <div className="amby-debug-stats-grid">
                  <Stat label={t("settings.debug.p50")} value={durationValue(stats.p50)} />
                  <Stat label={t("settings.debug.p95")} value={durationValue(stats.p95)} />
                  <Stat label={t("settings.debug.maximum")} value={durationValue(stats.max)} />
                </div>
              </details>
            </div>
            <h3 className="amby-debug-section-title">{t("settings.debug.slowestOperations")}</h3>
            <div className="amby-debug-slow-list">
              {slowEvents.length === 0 ? (
                <div className="amby-debug-empty">{t("settings.debug.noMeasurements")}</div>
              ) : (
                slowEvents.map((event) => <EventRow key={event.id} entry={event} />)
              )}
            </div>
          </TabsContent>

          <TabsContent value="report" className="amby-debug-pane flex min-h-0 flex-col">
            <p className="amby-debug-report-intro">{t("settings.debug.reportIntro")}</p>
            <ol className="amby-debug-report-steps">
              <li className={store.recording && !store.recording.endedAt ? "is-active" : ""}>
                <div>
                  <strong>{t("settings.debug.stepRecordTitle")}</strong>
                  <p>{t("settings.debug.stepRecordHint")}</p>
                </div>
                {!store.recording || store.recording.endedAt ? (
                  <Button onClick={startProblemCapture}>
                    <Bug className="size-3.5" /> {t("settings.debug.startCapture")}
                  </Button>
                ) : (
                  <span className="amby-debug-step-status">
                    {t("settings.debug.captureCount", {
                      count: store.recording.eventCount,
                      dropped: store.recording.dropped,
                    })}
                  </span>
                )}
              </li>
              <li className={store.recording && !store.recording.endedAt ? "is-active" : ""}>
                <div>
                  <strong>{t("settings.debug.stepReproduceTitle")}</strong>
                  <p>{t("settings.debug.stepReproduceHint")}</p>
                </div>
                <Button
                  variant="outline"
                  onClick={addMarker}
                  disabled={!store.recording || Boolean(store.recording.endedAt)}
                >
                  {t("settings.debug.markObserved")}
                </Button>
              </li>
              <li className={store.recording?.endedAt ? "is-complete" : ""}>
                <div>
                  <strong>{t("settings.debug.stepStopTitle")}</strong>
                  <p>
                    {store.recording?.endedAt
                      ? t("settings.debug.captureStopped")
                      : t("settings.debug.stepStopHint")}
                  </p>
                </div>
                <Button
                  variant="outline"
                  onClick={store.stopRecording}
                  disabled={!store.recording || Boolean(store.recording.endedAt)}
                >
                  {t("settings.debug.stopCapture")}
                </Button>
              </li>
              <li className={reportPreview ? "is-complete" : ""}>
                <div>
                  <strong>{t("settings.debug.stepExportTitle")}</strong>
                  <p>{t("settings.debug.stepExportHint")}</p>
                </div>
                <div className="amby-debug-overview-actions">
                  <Button
                    variant="outline"
                    onClick={createReport}
                    disabled={!store.health || Boolean(store.recording && !store.recording.endedAt)}
                  >
                    {t("settings.debug.previewReport")}
                  </Button>
                  <Button onClick={() => void exportCurrentReport()} disabled={!reportPreview}>
                    <Download className="size-3.5" /> {t("settings.debug.exportReport")}
                  </Button>
                </div>
              </li>
            </ol>
            <details className="amby-debug-disclosure">
              <summary>{t("settings.debug.reportDataDetails")}</summary>
              <p>{t("settings.debug.capturePrivacy")}</p>
              <p>{t("settings.debug.reportPrivacy")}</p>
            </details>
            <label className="amby-debug-description">
              {t("settings.debug.descriptionLabel")}
              <textarea
                value={userDescription}
                onChange={(event) => setUserDescription(event.target.value.slice(0, 500))}
                maxLength={500}
                placeholder={t("settings.debug.descriptionHint")}
              />
            </label>
            {reportPreview && (
              <details
                className="amby-debug-disclosure amby-debug-report-preview-disclosure"
                open={reportPreviewOpen}
                onToggle={(event) => setReportPreviewOpen(event.currentTarget.open)}
              >
                <summary>
                  {reportPreviewOpen
                    ? t("settings.debug.hidePreview")
                    : t("settings.debug.showPreview")}
                </summary>
                <pre className="amby-debug-report-preview select-text">{reportPreview}</pre>
              </details>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
