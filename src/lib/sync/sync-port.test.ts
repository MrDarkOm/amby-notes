import { beforeEach, describe, expect, it, vi } from "vitest"

const commands = vi.hoisted(() => ({
  syncStatus: vi.fn(),
  syncCheckServer: vi.fn(),
  syncCheckPassword: vi.fn(),
  syncPrepareAccount: vi.fn(),
  syncConfirmRecoveryCode: vi.fn(),
  syncCancelPending: vi.fn(),
  syncSetEnrollCode: vi.fn(),
  syncSignIn: vi.fn(),
  syncRecover: vi.fn(),
  syncListDevices: vi.fn(),
  syncDisconnectDevice: vi.fn(),
  syncSignOut: vi.fn(),
  exportTextFile: vi.fn(),
}))
vi.mock("@/lib/bindings", () => ({ commands }))
const tauri = vi.hoisted(() => ({ isTauri: vi.fn(() => true) }))
vi.mock("@/lib/storage", () => tauri)

import {
  RECOVERY_CODE_FILE_NAME,
  SyncPortError,
  createDesktopSyncPort,
  resolveSyncPort,
  unavailableSyncPort,
} from "./sync-port"

const ok = <T>(data: T) => ({ status: "ok" as const, data })
const failed = (code: string, retryAfterSecs: number | null = null) => ({
  status: "error" as const,
  error: { code, retryAfterSecs },
})

describe("the desktop sync port", () => {
  beforeEach(() => vi.resetAllMocks())

  it("passes the arguments of each command in the order of the generated bindings", async () => {
    const port = createDesktopSyncPort()
    commands.syncCheckServer.mockResolvedValue(ok({ url: "https://s" }))
    await port.checkServer({ url: "sync.example.com", allowHttp: true })
    expect(commands.syncCheckServer).toHaveBeenCalledWith("sync.example.com", true)

    commands.syncPrepareAccount.mockResolvedValue(ok({ recoveryCode: "X", confirmGroups: [1, 2] }))
    await port.prepareAccount({
      url: "u",
      allowHttp: false,
      username: "alice",
      enrollCode: "CODE",
      password: "pw",
      deviceName: "Mac",
    })
    expect(commands.syncPrepareAccount).toHaveBeenCalledWith(
      "u",
      false,
      "alice",
      "CODE",
      "pw",
      "Mac",
    )

    commands.syncSignIn.mockResolvedValue(ok({ connected: true }))
    await port.signIn({
      url: "u",
      allowHttp: false,
      username: "alice",
      password: "pw",
      deviceName: "Mac",
    })
    expect(commands.syncSignIn).toHaveBeenCalledWith("u", false, "alice", "pw", "Mac")

    commands.syncRecover.mockResolvedValue(ok({ connected: true }))
    await port.recover({
      url: "u",
      allowHttp: false,
      username: "alice",
      recoveryCode: "R",
      newPassword: "new",
      deviceName: "Mac",
    })
    expect(commands.syncRecover).toHaveBeenCalledWith("u", false, "alice", "R", "new", "Mac")

    commands.syncConfirmRecoveryCode.mockResolvedValue(ok({ connected: true }))
    await port.confirmRecoveryCode(["AAAA", "BBBB"])
    expect(commands.syncConfirmRecoveryCode).toHaveBeenCalledWith(["AAAA", "BBBB"])

    commands.syncDisconnectDevice.mockResolvedValue(ok(null))
    await port.disconnectDevice("d2")
    expect(commands.syncDisconnectDevice).toHaveBeenCalledWith("d2")

    commands.syncSetEnrollCode.mockResolvedValue(ok(null))
    await port.setEnrollCode("NEW")
    expect(commands.syncSetEnrollCode).toHaveBeenCalledWith("NEW")

    commands.syncCheckPassword.mockResolvedValue({ ok: true })
    await port.checkPassword("pw", "alice")
    expect(commands.syncCheckPassword).toHaveBeenCalledWith("pw", "alice")
  })

  it("returns the data of an ok answer and nothing for commands without one", async () => {
    const port = createDesktopSyncPort()
    commands.syncListDevices.mockResolvedValue(ok([{ deviceId: "d1" }]))
    await expect(port.listDevices()).resolves.toEqual([{ deviceId: "d1" }])
    commands.syncSignOut.mockResolvedValue(ok({ serverNotified: false }))
    await expect(port.signOut()).resolves.toEqual({ serverNotified: false })
    commands.syncCancelPending.mockResolvedValue(undefined)
    await expect(port.cancelPending()).resolves.toBeUndefined()
  })

  it("turns an error answer into a SyncPortError with the machine code and the wait", async () => {
    const port = createDesktopSyncPort()
    commands.syncSignIn.mockResolvedValue(failed("rate_limited", 840))
    const error = await port
      .signIn({ url: "u", allowHttp: false, username: "a", password: "p", deviceName: "d" })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SyncPortError)
    expect((error as SyncPortError).code).toBe("rate_limited")
    expect((error as SyncPortError).retryAfterSecs).toBe(840)
    commands.syncStatus.mockResolvedValue(failed("keychain_unavailable"))
    await expect(port.status()).rejects.toMatchObject({
      code: "keychain_unavailable",
      retryAfterSecs: null,
    })
  })

  it("does not leak the text of a transport failure", async () => {
    // an exception of the IPC layer may carry anything, even a path
    const port = createDesktopSyncPort()
    commands.syncStatus.mockRejectedValue(new Error("secret detail /Users/alice/token"))
    const error = (await port.status().catch((caught: unknown) => caught)) as SyncPortError
    expect(error).toBeInstanceOf(SyncPortError)
    expect(error.code).toBe("ipc_failed")
    expect(error.message).not.toContain("secret")
  })

  it("saves the recovery code through the save dialog under a fixed name", async () => {
    const port = createDesktopSyncPort()
    commands.exportTextFile.mockResolvedValue(ok("/tmp/amby-recovery-code.txt"))
    await expect(port.saveRecoveryCode("the text")).resolves.toBe("/tmp/amby-recovery-code.txt")
    expect(commands.exportTextFile).toHaveBeenCalledWith("the text", RECOVERY_CODE_FILE_NAME)
    commands.exportTextFile.mockResolvedValue(ok(null))
    await expect(port.saveRecoveryCode("the text")).resolves.toBeNull()
    commands.exportTextFile.mockResolvedValue({ status: "error", error: "disk full" })
    await expect(port.saveRecoveryCode("the text")).rejects.toMatchObject({ code: "storage_error" })
  })
})

describe("the port of the browser build", () => {
  it("refuses every action with the code `unavailable` and reports no connection", async () => {
    await expect(unavailableSyncPort.status()).resolves.toMatchObject({
      connected: false,
      keysMissing: false,
      pending: false,
    })
    await expect(
      unavailableSyncPort.checkServer({ url: "u", allowHttp: false }),
    ).rejects.toMatchObject({
      code: "unavailable",
    })
    await expect(unavailableSyncPort.listDevices()).rejects.toMatchObject({ code: "unavailable" })
    await expect(unavailableSyncPort.signOut()).rejects.toMatchObject({ code: "unavailable" })
    await expect(unavailableSyncPort.prepareAccount({} as never)).rejects.toMatchObject({
      code: "unavailable",
    })
  })

  it("is chosen outside the desktop application", () => {
    tauri.isTauri.mockReturnValue(false)
    expect(resolveSyncPort()).toBe(unavailableSyncPort)
    tauri.isTauri.mockReturnValue(true)
    expect(resolveSyncPort()).not.toBe(unavailableSyncPort)
  })
})
