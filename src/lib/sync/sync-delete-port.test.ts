import { beforeEach, describe, expect, it, vi } from "vitest"

const commands = vi.hoisted(() => ({ syncDeleteSpace: vi.fn() }))
vi.mock("@/lib/bindings", () => ({ commands }))

import { createDesktopSyncPort, SyncPortError } from "./sync-port"

describe("server-space deletion through IPC (Л9)", () => {
  beforeEach(() => vi.resetAllMocks())

  it("passes only the selected space ID to the generated command", async () => {
    commands.syncDeleteSpace.mockResolvedValue({ status: "ok", data: null })
    await createDesktopSyncPort().deleteSpace("ab".repeat(16))
    expect(commands.syncDeleteSpace).toHaveBeenCalledExactlyOnceWith("ab".repeat(16))
  })

  it("keeps the machine error and retry delay for the action's inline result", async () => {
    commands.syncDeleteSpace.mockResolvedValue({
      status: "error",
      error: { code: "rate_limited", retryAfterSecs: 9 },
    })
    await expect(createDesktopSyncPort().deleteSpace("ab".repeat(16))).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterSecs: 9,
    })
  })

  it("maps an IPC failure without exposing its raw text", async () => {
    commands.syncDeleteSpace.mockRejectedValue(new Error("private device details"))
    await expect(createDesktopSyncPort().deleteSpace("ab".repeat(16))).rejects.toEqual(
      new SyncPortError("ipc_failed"),
    )
  })
})
