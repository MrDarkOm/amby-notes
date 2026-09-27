import { expect, it, vi } from "vitest"
import { projectSharedDebugHealth, requestWorkspaceDebugHealth } from "./health-bridge"

const eventRuntime = vi.hoisted(() => ({
  callback: null as ((event: { payload: unknown }) => void) | null,
  stop: vi.fn(),
  emit: vi.fn(),
}))
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event, callback) => {
    eventRuntime.callback = callback
    return eventRuntime.stop
  }),
  emitTo: eventRuntime.emit,
}))

it("shares only explicit health aggregates with the detached settings window", async () => {
  eventRuntime.emit.mockImplementation(async (_target, _event, payload) => {
    eventRuntime.callback?.({
      payload: {
        requestId: payload.requestId,
        snapshot: {
          documents: { open: 3, dirty: 1, title: "PRIVATE_TITLE" },
          autosave: { paused: 1, inFlight: 2, error: "PRIVATE_ERROR" },
          modules: { enabled: 4, safeMode: true },
          editorReasons: { round_trip_mismatch: 1, PRIVATE_NOTE: 8 },
          path: "PRIVATE_PATH",
        },
      },
    })
  })
  const result = await requestWorkspaceDebugHealth()
  expect(result.documents.open).toBe(3)
  expect(result.autosave.paused).toBe(1)
  expect(result.modules).toEqual({ enabled: 4, safeMode: true })
  expect(result.editorReasons).toEqual({ round_trip_mismatch: 1 })
  expect(JSON.stringify(result)).not.toContain("PRIVATE_")
  expect(eventRuntime.stop).toHaveBeenCalled()
})

it("times out instead of presenting empty local stores as the main workspace", async () => {
  vi.useFakeTimers()
  eventRuntime.emit.mockResolvedValue(undefined)
  const result = requestWorkspaceDebugHealth()
  const expectation = expect(result).rejects.toThrow("DEBUG_HEALTH_UNAVAILABLE")
  await vi.advanceTimersByTimeAsync(2001)
  await expectation
  vi.useRealTimers()
})

it("rejects invalid counters and unexpected keys", () => {
  const projection = projectSharedDebugHealth({
    documents: { open: -1, dirty: "secret" },
    modules: { safeMode: "secret" },
  })
  expect(projection.documents.open).toBe(0)
  expect(projection.documents.dirty).toBe(0)
  expect(projection.modules.safeMode).toBe(false)
})
