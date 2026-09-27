import { create } from "zustand"
import {
  clearLogEntries,
  clearPersistedLogs,
  getLogEntries,
  getLoggerStatus,
  loadLogHistory,
  subscribeToLogChanges,
  subscribeToLogs,
  type LogEntry,
} from "@/lib/logger"
import { collectDebugHealth, type DebugHealthSnapshot } from "@/lib/debug/health"
import type { DebugConfig } from "@/lib/debug/types"
import { useSettingsStore } from "../use-settings-store"
import {
  addRecordingMarker,
  appendRecordingEvent,
  startDebugRecording,
  stopDebugRecording,
  DEBUG_RECORDING_LIMIT,
  type DebugRecording,
} from "./debug-session"

const MAX_DISPLAY_EVENTS = 6_000
const DISPLAY_UPDATE_MS = 100
const CAPTURE_DEBUG_CONFIG = { enabled: true, logLevel: "debug" as const }

interface DebugStore {
  events: LogEntry[]
  status: ReturnType<typeof getLoggerStatus>
  health: DebugHealthSnapshot | null
  historyLoaded: boolean
  loading: boolean
  error: string | null
  displayPaused: boolean
  recording: DebugRecording | null
  recordingEvents: LogEntry[]
  hydrate: () => Promise<void>
  refresh: () => Promise<void>
  setDisplayPaused: (paused: boolean) => void
  clearScreen: () => void
  deletePersistedHistory: () => Promise<void>
  startRecording: () => void
  stopRecording: () => void
  addMarker: (label: string) => void
  resetError: () => void
}

let unsubscribeLogs: (() => void) | null = null
let unsubscribeChanges: (() => void) | null = null
let displayUpdateTimer: ReturnType<typeof setTimeout> | null = null
let recordingTimeout: ReturnType<typeof setTimeout> | null = null
let recordedIds = new Set<string>()
let recordingData: { recording: DebugRecording | null; events: LogEntry[] } | null = null
let configBeforeCapture: DebugConfig | null = null
let configDuringCapture: DebugConfig | null = null

function mergeEvents(...collections: LogEntry[][]): LogEntry[] {
  const byId = new Map<string, LogEntry>()
  for (const collection of collections) for (const event of collection) byId.set(event.id, event)
  return [...byId.values()]
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
    .slice(-MAX_DISPLAY_EVENTS)
}

function installSubscriptions(set: (partial: Partial<DebugStore>) => void, get: () => DebugStore) {
  if (unsubscribeLogs && unsubscribeChanges) return
  unsubscribeLogs?.()
  unsubscribeChanges?.()
  unsubscribeLogs = subscribeToLogs((event) => {
    if (!recordingData?.recording || recordingData.recording.endedAt || recordedIds.has(event.id))
      return
    if (recordingData.events.length < DEBUG_RECORDING_LIMIT) recordedIds.add(event.id)
    recordingData = appendRecordingEvent(recordingData, event)
    scheduleDisplayUpdate(set, get)
  })
  unsubscribeChanges = subscribeToLogChanges(() => {
    const status = getLoggerStatus()
    if (status.clearRevision !== get().status.clearRevision) {
      // A clear broadcast from another window also invalidates retained display history.
      // This applies while paused: resuming must never resurrect the cleared stream.
      set({ events: getLogEntries(), status, historyLoaded: true })
    }
    scheduleDisplayUpdate(set, get)
  })
}

function scheduleDisplayUpdate(set: (partial: Partial<DebugStore>) => void, get: () => DebugStore) {
  if (displayUpdateTimer) return
  displayUpdateTimer = setTimeout(() => {
    displayUpdateTimer = null
    const state = get()
    const next: Partial<DebugStore> = { status: getLoggerStatus() }
    if (!state.displayPaused) {
      next.events = mergeEvents(state.events, getLogEntries())
      if (recordingData) {
        next.recording = recordingData.recording
        next.recordingEvents = recordingData.events
      }
    }
    set(next)
  }, DISPLAY_UPDATE_MS)
}

export const useDebugStore = create<DebugStore>((set, get) => ({
  events: getLogEntries(),
  status: getLoggerStatus(),
  health: null,
  historyLoaded: false,
  loading: false,
  error: null,
  displayPaused: false,
  recording: null,
  recordingEvents: [],
  hydrate: async () => {
    if (get().loading || get().historyLoaded) return
    set({ loading: true, error: null })
    installSubscriptions(set, get)
    const clearRevision = getLoggerStatus().clearRevision
    try {
      const [history, health] = await Promise.all([
        loadLogHistory(),
        collectDebugHealth().catch(() => null),
      ])
      set({
        events: mergeEvents(
          getLoggerStatus().clearRevision === clearRevision ? history : [],
          getLogEntries(),
        ),
        health,
        historyLoaded: true,
        status: getLoggerStatus(),
        error: health ? null : "DEBUG_HEALTH_UNAVAILABLE",
        loading: false,
      })
    } catch {
      set({ error: "DEBUG_HEALTH_UNAVAILABLE", loading: false, status: getLoggerStatus() })
    }
  },
  refresh: async () => {
    set({ loading: true, error: null })
    installSubscriptions(set, get)
    const clearRevision = getLoggerStatus().clearRevision
    try {
      const [history, health] = await Promise.all([
        loadLogHistory(),
        collectDebugHealth().catch(() => null),
      ])
      set({
        events: get().displayPaused
          ? get().events
          : mergeEvents(
              getLoggerStatus().clearRevision === clearRevision ? history : [],
              getLogEntries(),
            ),
        health,
        status: getLoggerStatus(),
        historyLoaded: true,
        error: health ? null : "DEBUG_HEALTH_UNAVAILABLE",
        loading: false,
      })
    } catch {
      set({ error: "DEBUG_REFRESH_UNAVAILABLE", loading: false, status: getLoggerStatus() })
    }
  },
  setDisplayPaused: (displayPaused) => {
    const events = displayPaused
      ? {}
      : {
          events: mergeEvents(get().events, getLogEntries()),
          ...(recordingData
            ? { recording: recordingData.recording, recordingEvents: recordingData.events }
            : {}),
        }
    set({ displayPaused, ...events })
  },
  clearScreen: () => {
    clearLogEntries()
    set({ events: [], status: getLoggerStatus() })
  },
  deletePersistedHistory: async () => {
    await clearPersistedLogs()
    set({ events: [], historyLoaded: true, status: getLoggerStatus() })
  },
  startRecording: () => {
    installSubscriptions(set, get)
    if (recordingTimeout) clearTimeout(recordingTimeout)
    const config = useSettingsStore.getState().prefs.debug
    configBeforeCapture = { ...config }
    configDuringCapture = { ...config, ...CAPTURE_DEBUG_CONFIG }
    recordedIds = new Set()
    recordingData = startDebugRecording()
    if (!config.enabled || config.logLevel !== "debug") {
      void useSettingsStore
        .getState()
        .setPrefs({ debug: configDuringCapture })
        .catch(() => set({ error: "DEBUG_CONFIG_SYNC_FAILED" }))
    }
    set({
      recording: recordingData.recording,
      recordingEvents: recordingData.events,
      error: null,
    })
    recordingTimeout = setTimeout(() => get().stopRecording(), 5 * 60 * 1_000)
  },
  stopRecording: () => {
    if (recordingTimeout) clearTimeout(recordingTimeout)
    recordingTimeout = null
    const recording = stopDebugRecording(
      recordingData ?? { recording: get().recording, events: get().recordingEvents },
    )
    recordingData = recording
    recordedIds = new Set()
    set({ recording: recording.recording, recordingEvents: recording.events })
    const restore = configBeforeCapture
    const applied = configDuringCapture
    configBeforeCapture = null
    configDuringCapture = null
    if (restore && applied) {
      const current = useSettingsStore.getState().prefs.debug
      if (
        current.enabled === applied.enabled &&
        current.logLevel === applied.logLevel &&
        current.logToFile === applied.logToFile
      ) {
        void useSettingsStore
          .getState()
          .setPrefs({ debug: restore })
          .catch(() => {
            set({ error: "DEBUG_CONFIG_RESTORE_FAILED" })
          })
      }
    }
    void collectDebugHealth()
      .then((health) => set({ health }))
      .catch(() => {
        set({ error: "DEBUG_HEALTH_UNAVAILABLE" })
      })
  },
  addMarker: (label) => {
    const recording = addRecordingMarker(
      recordingData ?? { recording: get().recording, events: get().recordingEvents },
      label,
    )
    recordingData = recording
    set({ recording: recording.recording, recordingEvents: recording.events })
  },
  resetError: () => set({ error: null }),
}))
