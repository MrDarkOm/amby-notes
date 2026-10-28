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
  syncAccountOverview: vi.fn(),
  exportTextFile: vi.fn(),
}))
vi.mock("@/lib/bindings", () => ({ commands }))
const tauri = vi.hoisted(() => ({ isTauri: vi.fn(() => true) }))
vi.mock("@/lib/storage", () => tauri)
const eventApi = vi.hoisted(() => ({ listen: vi.fn() }))
vi.mock("@tauri-apps/api/event", () => eventApi)

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

  it("keeps status reads silent unless the sign-in action explicitly permits interaction", async () => {
    const port = createDesktopSyncPort()
    commands.syncStatus.mockResolvedValue(ok({ connected: false }))
    await port.status()
    expect(commands.syncStatus).toHaveBeenLastCalledWith(false)
    await port.status(true)
    expect(commands.syncStatus).toHaveBeenLastCalledWith(true)
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

describe("the desktop sync port: the sync of the open vault", () => {
  beforeEach(() => vi.resetAllMocks())

  it("passes the arguments of each command in the order of the generated bindings", async () => {
    Object.assign(commands, {
      syncVaultStatus: vi.fn(),
      syncListSpaces: vi.fn(),
      syncEnableVault: vi.fn(),
      syncDisableVault: vi.fn(),
      syncRunNow: vi.fn(),
      syncApprove: vi.fn(),
      syncResolveConflict: vi.fn(),
      syncReadConflictVersions: vi.fn(),
      syncResolveConflictWithText: vi.fn(),
    })
    const c = commands as unknown as Record<string, ReturnType<typeof vi.fn>>
    const port = createDesktopSyncPort()

    c.syncVaultStatus.mockResolvedValue({ enabled: true })
    expect(await port.vaultStatus()).toEqual({ enabled: true })

    c.syncListSpaces.mockResolvedValue(ok([{ spaceId: "aa" }]))
    expect(await port.listSpaces()).toEqual([{ spaceId: "aa" }])

    c.syncEnableVault.mockResolvedValue(ok({ enabled: true }))
    await port.enableVault({ kind: "new", name: "Work" }, true)
    expect(c.syncEnableVault).toHaveBeenCalledWith({ kind: "new", name: "Work" }, true)

    c.syncDisableVault.mockResolvedValue(ok({ enabled: false }))
    expect(await port.disableVault()).toEqual({ enabled: false })

    c.syncRunNow.mockResolvedValue(ok(null))
    await port.runNow()
    expect(c.syncRunNow).toHaveBeenCalledTimes(1)

    c.syncApprove.mockResolvedValue(ok(null))
    await port.approve("massChange")
    expect(c.syncApprove).toHaveBeenCalledWith("massChange")

    c.syncResolveConflict.mockResolvedValue(ok(null))
    await port.resolveConflict("0123456789ab", "keepCopy")
    expect(c.syncResolveConflict).toHaveBeenCalledWith("0123456789ab", "keepCopy")

    // the comparison (stage Э4б): both versions as text, and the assembled text as the answer
    c.syncReadConflictVersions.mockResolvedValue(ok({ original: "mine", copy: null, stamp: "s1" }))
    expect(await port.readConflictVersions("0123456789ab")).toEqual({
      original: "mine",
      copy: null,
      stamp: "s1",
    })
    expect(c.syncReadConflictVersions).toHaveBeenCalledWith("0123456789ab")

    c.syncResolveConflictWithText.mockResolvedValue(ok(null))
    await port.resolveConflictWithText("0123456789ab", "\ufeffa\r\nb", "s1")
    expect(c.syncResolveConflictWithText).toHaveBeenCalledWith("0123456789ab", "\ufeffa\r\nb", "s1")
  })

  it("refuses to compare or resolve with a text in the browser build", async () => {
    await expect(unavailableSyncPort.readConflictVersions("x")).rejects.toMatchObject({
      code: "unavailable",
    })
    await expect(unavailableSyncPort.resolveConflictWithText("x", "t", "s")).rejects.toMatchObject({
      code: "unavailable",
    })
  })

  it("turns a failed command into a SyncPortError with the machine code", async () => {
    const c = commands as unknown as Record<string, ReturnType<typeof vi.fn>>
    c.syncEnableVault = vi.fn().mockResolvedValue(failed("storage_error"))
    const port = createDesktopSyncPort()
    await expect(port.enableVault({ kind: "new", name: "" }, false)).rejects.toMatchObject({
      name: "SyncPortError",
      code: "storage_error",
    })
    c.syncApprove = vi.fn().mockRejectedValue(new Error("raw text with /Users/x/path"))
    await expect(port.approve("resync")).rejects.toMatchObject({ code: "ipc_failed" })
  })

  it("listens to the status events of the application and stops on request", async () => {
    const stop = vi.fn()
    let handler: ((event: { payload: unknown }) => void) | null = null
    eventApi.listen.mockImplementation(
      async (name: string, callback: (event: { payload: unknown }) => void) => {
        expect(name).toBe("sync-status-changed")
        handler = callback
        return stop
      },
    )
    const port = createDesktopSyncPort()
    const seen: unknown[] = []
    const unlisten = await port.onVaultStatus((status) => seen.push(status))
    ;(handler as unknown as (event: { payload: unknown }) => void)({
      payload: { enabled: true, phase: "idle" },
    })
    expect(seen).toEqual([{ enabled: true, phase: "idle" }])
    unlisten()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it("tells the listener which vault and which files another computer deleted", async () => {
    let handler: ((event: { payload: unknown }) => void) | null = null
    const stop = vi.fn()
    eventApi.listen.mockImplementation(
      async (name: string, callback: (event: { payload: unknown }) => void) => {
        expect(name).toBe("sync-remote-deleted")
        handler = callback
        return stop
      },
    )
    const port = createDesktopSyncPort()
    const seen: unknown[] = []
    const unlisten = await port.onRemoteDeleted((event) => seen.push(event))
    ;(handler as unknown as (event: { payload: unknown }) => void)({
      payload: { vault: "/Users/me/Notes", paths: ["Notes/a.md"] },
    })
    expect(seen).toEqual([{ vault: "/Users/me/Notes", paths: ["Notes/a.md"] }])
    unlisten()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it("the browser build has no vault to synchronise and refuses to switch it on", async () => {
    const status = await unavailableSyncPort.vaultStatus()
    expect(status.phase).toBe("off")
    expect(status.enabled).toBe(false)
    await expect(
      unavailableSyncPort.enableVault({ kind: "new", name: "" }, true),
    ).rejects.toMatchObject({
      code: "unavailable",
    })
    const unlisten = await unavailableSyncPort.onVaultStatus(() => {})
    expect(() => unlisten()).not.toThrow()
  })
})

describe("the account overview of appendix Е (У5)", () => {
  beforeEach(() => vi.resetAllMocks())

  it("passes the folders of the known vaults to the command and returns the answer", async () => {
    const port = createDesktopSyncPort()
    commands.syncAccountOverview.mockResolvedValue(ok({ limitsKnown: true, spaces: [] }))
    expect(await port.accountOverview(["/a", "/b"])).toEqual({ limitsKnown: true, spaces: [] })
    expect(commands.syncAccountOverview).toHaveBeenCalledWith(["/a", "/b"])
  })

  it("turns a failure into the machine code and has nothing in the browser build", async () => {
    const port = createDesktopSyncPort()
    commands.syncAccountOverview.mockResolvedValue(failed("unauthorized"))
    await expect(port.accountOverview([])).rejects.toMatchObject({ code: "unauthorized" })
    await expect(unavailableSyncPort.accountOverview([])).rejects.toMatchObject({
      code: "unavailable",
    })
  })
})
