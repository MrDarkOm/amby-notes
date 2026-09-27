import { afterEach, describe, expect, it, vi } from "vitest"
import { commands } from "../bindings"
import type { DebugEvent } from "../debug/types"
import {
  appendDebugEvents,
  clearDebugLogs,
  configureDebugRepositoryRuntime,
  getDebugEvents,
  getDebugHistory,
  getDebugStatus,
} from "./debug-repository"

const sample: DebugEvent = {
  id: "evt_550e8400-e29b-41d4-a716-446655440000",
  timestamp: "2026-09-27T08:00:00.000Z",
  level: "info",
  event: "app.started",
  source: "frontend",
}

describe("debug storage repository", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    configureDebugRepositoryRuntime({ isNative: () => false })
    void clearDebugLogs()
  })

  it("keeps browser events in memory and explicitly has no native history", async () => {
    configureDebugRepositoryRuntime({ isNative: () => false })
    await appendDebugEvents([sample])
    expect(await getDebugEvents()).toEqual([sample])
    expect(await getDebugHistory()).toEqual([])
    expect(await getDebugStatus()).toBeNull()
  })

  it("unwraps and surfaces backend Result errors", async () => {
    configureDebugRepositoryRuntime({ isNative: () => true })
    vi.spyOn(commands, "getDebugStatus").mockResolvedValue({
      status: "error",
      error: "VaultUnavailable",
    } as never)
    await expect(getDebugStatus()).rejects.toThrow("VaultUnavailable")
  })
})
