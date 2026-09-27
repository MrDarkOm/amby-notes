import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LogEntry } from "@/lib/logger"

const mocks = vi.hoisted(() => ({
  entries: [] as LogEntry[],
  history: [] as LogEntry[],
  historyWait: null as Promise<LogEntry[]> | null,
  clearRevision: 0,
  entryListeners: [] as Array<(event: LogEntry) => void>,
  changeListeners: [] as Array<() => void>,
  debugConfig: {
    enabled: false,
    logLevel: "info" as "debug" | "info" | "warn" | "error",
    logToFile: false,
  },
  setPrefs: vi.fn(
    async ({
      debug,
    }: {
      debug: { enabled: boolean; logLevel: "debug" | "info" | "warn" | "error"; logToFile: boolean }
    }) => {
      mocks.debugConfig = debug
    },
  ),
}))

vi.mock("@/lib/logger", () => ({
  clearLogEntries: vi.fn(() => {
    mocks.clearRevision += 1
    mocks.entries = []
    mocks.changeListeners.forEach((listener) => listener())
  }),
  getLogEntries: vi.fn(() => [...mocks.entries]),
  getLoggerStatus: vi.fn(() => ({
    buffered: mocks.entries.length,
    clearRevision: mocks.clearRevision,
    dropped: 0,
    pending: 0,
    transportError: null,
    backend: null,
  })),
  clearPersistedLogs: vi.fn(async () => {
    mocks.clearRevision += 1
    mocks.entries = []
    mocks.history = []
    mocks.changeListeners.forEach((listener) => listener())
  }),
  loadLogHistory: vi.fn(async () => mocks.historyWait ?? [...mocks.history]),
  subscribeToLogChanges: vi.fn((listener: () => void) => {
    mocks.changeListeners.push(listener)
    return () => {
      mocks.changeListeners = mocks.changeListeners.filter((candidate) => candidate !== listener)
    }
  }),
  subscribeToLogs: vi.fn((listener: (event: LogEntry) => void) => {
    mocks.entryListeners.push(listener)
    return () => {
      mocks.entryListeners = mocks.entryListeners.filter((candidate) => candidate !== listener)
    }
  }),
}))

vi.mock("@/lib/debug/health", () => ({
  collectDebugHealth: vi.fn(async () => ({
    runtime: "browser",
    generatedAt: "2026-09-27T10:00:00.000Z",
    documents: { open: 0, dirty: 0, conflicts: 0, source: 0, livePreview: 0 },
    autosave: { participants: 0, scheduled: 0, inFlight: 0, paused: 0, dirty: 0, errors: 0 },
    recovery: { pending: 0, failed: 0 },
    modules: { enabled: 0, safeMode: false },
    backend: null,
    editorReasons: {},
  })),
}))

vi.mock("../use-settings-store", () => ({
  useSettingsStore: {
    getState: () => ({
      prefs: { debug: mocks.debugConfig },
      setPrefs: mocks.setPrefs,
    }),
  },
}))

let useDebugStore: typeof import("./use-debug-store").useDebugStore

function entry(id: string, event = "diagnostic.test"): LogEntry {
  return {
    id,
    timestamp: new Date(1_000 + Number(id)).toISOString(),
    event,
    level: "info",
    source: "frontend",
  }
}

function emit(event: LogEntry) {
  mocks.entries.push(event)
  mocks.entryListeners.forEach((listener) => listener(event))
  mocks.changeListeners.forEach((listener) => listener())
}

describe("debug store", () => {
  beforeEach(async () => {
    vi.resetModules()
    ;({ useDebugStore } = await import("./use-debug-store"))
    vi.useFakeTimers()
    mocks.entries = []
    mocks.history = [entry("1", "diagnostic.retained")]
    mocks.historyWait = null
    mocks.clearRevision = 0
    mocks.entryListeners = []
    mocks.changeListeners = []
    mocks.debugConfig = { enabled: false, logLevel: "info", logToFile: false }
    mocks.setPrefs.mockClear()
    useDebugStore.setState({
      events: [],
      status: {
        buffered: 0,
        clearRevision: 0,
        dropped: 0,
        pending: 0,
        transportError: null,
        backend: null,
      },
      health: null,
      historyLoaded: false,
      loading: false,
      error: null,
      displayPaused: false,
      recording: null,
      recordingEvents: [],
    })
  })

  afterEach(() => {
    useDebugStore.getState().stopRecording()
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it("retains loaded history when live events arrive and freezes only the display", async () => {
    await useDebugStore.getState().hydrate()
    expect(useDebugStore.getState().events.map((item) => item.id)).toContain("1")

    useDebugStore.getState().setDisplayPaused(true)
    emit(entry("2", "diagnostic.live"))
    await vi.advanceTimersByTimeAsync(120)
    expect(useDebugStore.getState().events.map((item) => item.id)).toEqual(["1"])

    useDebugStore.getState().setDisplayPaused(false)
    expect(useDebugStore.getState().events.map((item) => item.id)).toContain("1")
    expect(useDebugStore.getState().events.map((item) => item.id)).toContain("2")
  })

  it("captures incrementally while paused and restores temporary debug level", () => {
    useDebugStore.getState().startRecording()
    expect(mocks.debugConfig).toEqual({ enabled: true, logLevel: "debug", logToFile: false })
    useDebugStore.getState().setDisplayPaused(true)
    emit(entry("3"))
    emit(entry("4"))

    expect(useDebugStore.getState().recordingEvents).toEqual([])
    useDebugStore.getState().setDisplayPaused(false)
    expect(useDebugStore.getState().recordingEvents.map((item) => item.id)).toEqual(["3", "4"])
    useDebugStore.getState().stopRecording()
    expect(mocks.debugConfig).toEqual({ enabled: false, logLevel: "info", logToFile: false })
  })

  it("preserves a user configuration change made during capture", () => {
    useDebugStore.getState().startRecording()
    mocks.debugConfig = { enabled: true, logLevel: "warn", logToFile: true }
    useDebugStore.getState().stopRecording()
    expect(mocks.debugConfig).toEqual({ enabled: true, logLevel: "warn", logToFile: true })
  })

  it("deletes retained history from the displayed stream after backend clear succeeds", async () => {
    await useDebugStore.getState().hydrate()
    expect(useDebugStore.getState().events).toHaveLength(1)
    await useDebugStore.getState().deletePersistedHistory()
    expect(useDebugStore.getState().events).toEqual([])
  })

  it("coalesces high-frequency UI updates during capture", () => {
    useDebugStore.getState().startRecording()
    let updates = 0
    const unsubscribe = useDebugStore.subscribe(() => {
      updates += 1
    })
    emit(entry("5"))
    emit(entry("6"))
    expect(updates).toBe(0)
    vi.advanceTimersByTime(100)
    expect(updates).toBe(1)
    unsubscribe()
  })

  it("drops retained display history on a remote clear, including while paused", async () => {
    await useDebugStore.getState().hydrate()
    useDebugStore.getState().setDisplayPaused(true)
    mocks.clearRevision += 1
    mocks.entries = []
    mocks.changeListeners.forEach((listener) => listener())
    expect(useDebugStore.getState().events).toEqual([])
    emit(entry("8"))
    await vi.advanceTimersByTimeAsync(120)
    expect(useDebugStore.getState().events).toEqual([])
    useDebugStore.getState().setDisplayPaused(false)
    expect(useDebugStore.getState().events.map((event) => event.id)).toEqual(["8"])
  })

  it("discards a history response started before a remote clear", async () => {
    let resolveHistory!: (events: LogEntry[]) => void
    mocks.historyWait = new Promise((resolve) => {
      resolveHistory = resolve
    })
    const hydration = useDebugStore.getState().hydrate()
    mocks.clearRevision += 1
    mocks.entries = []
    mocks.changeListeners.forEach((listener) => listener())
    emit(entry("9"))
    resolveHistory([entry("1", "diagnostic.retained")])
    await hydration
    expect(useDebugStore.getState().events.map((event) => event.id)).toEqual(["9"])
  })

  it("does not reintroduce cleared history when an in-flight refresh resolves", async () => {
    await useDebugStore.getState().hydrate()
    let resolveHistory!: (events: LogEntry[]) => void
    mocks.historyWait = new Promise((resolve) => {
      resolveHistory = resolve
    })
    const refresh = useDebugStore.getState().refresh()
    mocks.clearRevision += 1
    mocks.entries = []
    mocks.changeListeners.forEach((listener) => listener())
    resolveHistory([entry("1", "diagnostic.retained")])
    await refresh
    await vi.advanceTimersByTimeAsync(120)
    expect(useDebugStore.getState().events).toEqual([])
  })
})
