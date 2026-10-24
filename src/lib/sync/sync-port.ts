// Boundary between the interface and the sync commands of the Rust side (docs/sync-plan.md,
// stage Э4, the connect screen). The UI talks to a `SyncPort`; the desktop port calls the
// generated commands, the browser port refuses. Every failure is a `SyncPortError` with the
// machine code of the Rust side — the UI translates the code (sync-errors.ts), never a text.

import { commands } from "@/lib/bindings"
import { isTauri } from "@/lib/storage"
import type {
  ApprovalKind,
  ConflictChoice,
  ConflictVersions,
  Result,
  SpaceTarget,
  SpaceView,
  SyncError,
  DeviceView,
  PasswordCheck,
  PreparedAccountView,
  ServerCheck,
  SignOutResult,
  SyncStatus,
  VaultSyncStatus,
} from "@/lib/bindings"

export type {
  ApprovalKind,
  ConflictChoice,
  ConflictVersions,
  DeviceView,
  PasswordCheck,
  PreparedAccountView,
  ServerCheck,
  SpaceView,
  SyncStatus,
  VaultSyncStatus,
}

/** The name of the event the application emits when the sync status of the open vault changes. */
const VAULT_STATUS_EVENT = "sync-status-changed"

/** The event for files that another computer deleted. */
const REMOTE_DELETED_EVENT = "sync-remote-deleted"

/** Files of one vault that another computer deleted: the folder of the vault and the paths in it. */
export interface RemoteDeletedEvent {
  vault: string
  paths: string[]
}

/** The event for notes that came back after a deletion made on this computer; the payload is the paths. */
const RESTORED_AFTER_DELETION_EVENT = "sync-restored-after-deletion"

/** The default name of the recovery code file offered by "Save to file". */
export const RECOVERY_CODE_FILE_NAME = "amby-recovery-code.txt"

/** A failed sync command: the machine code and, for a rate limit, the seconds to wait. */
export class SyncPortError extends Error {
  readonly code: string
  readonly retryAfterSecs: number | null

  constructor(code: string, retryAfterSecs: number | null = null) {
    super(code)
    this.name = "SyncPortError"
    this.code = code
    this.retryAfterSecs = retryAfterSecs
  }
}

/** The server a command goes to: the address as typed and the "local network" switch (П41). */
interface ServerTarget {
  url: string
  allowHttp: boolean
}

interface PrepareAccountInput extends ServerTarget {
  username: string
  enrollCode: string
  password: string
  deviceName: string
}

interface SignInInput extends ServerTarget {
  username: string
  password: string
  deviceName: string
}

interface RecoverInput extends ServerTarget {
  username: string
  recoveryCode: string
  newPassword: string
  deviceName: string
}

/** Everything the connect screen can ask of the application. */
export interface SyncPort {
  /** The state of the connection; no network. */
  status(): Promise<SyncStatus>
  /** `/v1/info` of a server. */
  checkServer(target: ServerTarget): Promise<ServerCheck>
  /** The verdict on a password while it is typed. */
  checkPassword(password: string, username: string): Promise<PasswordCheck>
  /** Makes the keys of a new account; returns the recovery code to show. Nothing is sent. */
  prepareAccount(input: PrepareAccountInput): Promise<PreparedAccountView>
  /** The groups typed back; right ones send the account and connect the device. */
  confirmRecoveryCode(groups: string[]): Promise<SyncStatus>
  /** Another invitation code for the prepared account; the keys and the recovery code stay. */
  setEnrollCode(enrollCode: string): Promise<void>
  /** Forgets the prepared account. */
  cancelPending(): Promise<void>
  signIn(input: SignInInput): Promise<SyncStatus>
  recover(input: RecoverInput): Promise<SyncStatus>
  listDevices(): Promise<DeviceView[]>
  disconnectDevice(deviceId: string): Promise<void>
  signOut(): Promise<SignOutResult>
  /** Offers to save the recovery code as a text file; the path, or `null` when cancelled. */
  saveRecoveryCode(contents: string): Promise<string | null>

  // ----- the sync of the open vault (stage Э4) -----

  /** The state of the sync of the open vault; no network. */
  vaultStatus(): Promise<VaultSyncStatus>
  /** The spaces of the account, for "connect an existing vault". */
  listSpaces(): Promise<SpaceView[]>
  /** Switches sync on for the open vault: a new space or an existing one. */
  enableVault(target: SpaceTarget, testVault: boolean): Promise<VaultSyncStatus>
  /** Switches sync off for the open vault; the link with the space stays. */
  disableVault(): Promise<VaultSyncStatus>
  /** A pass now. */
  runNow(): Promise<void>
  /** The answer to a stop of Р8. */
  approve(kind: ApprovalKind): Promise<void>
  /** Resolves a conflict of the list. */
  resolveConflict(id: string, choice: ConflictChoice): Promise<void>
  /**
   * The two versions of a conflict as text for the comparison; a side is `null` when it cannot be shown
   * as text. Today they are the file and its copy; where the second version is kept is the engine's business.
   */
  readConflictVersions(id: string): Promise<ConflictVersions>
  /**
   * Resolves a conflict with a text put together by the comparison: it becomes the file byte for byte
   * (the replaced version stays in the history) and the conflict is cleared. `stamp` is the one
   * `readConflictVersions` returned: when either version has changed since, nothing is written and the
   * answer is `conflict_changed`.
   */
  resolveConflictWithText(id: string, text: string, stamp: string): Promise<void>
  /** Calls `listener` whenever the status changes; returns the function that stops it. */
  onVaultStatus(listener: (status: VaultSyncStatus) => void): Promise<() => void>
  /** Calls `listener` with the vault and the paths (in it) of files deleted on another computer. */
  onRemoteDeleted(listener: (event: RemoteDeletedEvent) => void): Promise<() => void>
  /**
   * Calls `listener` with the paths (in the vault) of notes this computer deleted that came back because
   * another computer edited them (Р7, Д37).
   */
  onRestoredAfterDeletion(listener: (paths: string[]) => void): Promise<() => void>
}

/** Unwraps the answer of a command. A failure of the IPC layer itself carries no text on purpose. */
async function call<T>(command: Promise<Result<T, SyncError>>): Promise<T> {
  let result: Result<T, SyncError>
  try {
    result = await command
  } catch {
    throw new SyncPortError("ipc_failed")
  }
  if (result.status === "ok") return result.data
  throw new SyncPortError(result.error.code, result.error.retryAfterSecs)
}

/** The port that calls the Rust commands. */
export function createDesktopSyncPort(): SyncPort {
  return {
    status: () => call(commands.syncStatus()),
    checkServer: ({ url, allowHttp }) => call(commands.syncCheckServer(url, allowHttp)),
    checkPassword: async (password, username) => {
      try {
        return await commands.syncCheckPassword(password, username)
      } catch {
        throw new SyncPortError("ipc_failed")
      }
    },
    prepareAccount: ({ url, allowHttp, username, enrollCode, password, deviceName }) =>
      call(commands.syncPrepareAccount(url, allowHttp, username, enrollCode, password, deviceName)),
    confirmRecoveryCode: (groups) => call(commands.syncConfirmRecoveryCode(groups)),
    setEnrollCode: async (enrollCode) => {
      await call(commands.syncSetEnrollCode(enrollCode))
    },
    cancelPending: async () => {
      try {
        await commands.syncCancelPending()
      } catch {
        throw new SyncPortError("ipc_failed")
      }
    },
    signIn: ({ url, allowHttp, username, password, deviceName }) =>
      call(commands.syncSignIn(url, allowHttp, username, password, deviceName)),
    recover: ({ url, allowHttp, username, recoveryCode, newPassword, deviceName }) =>
      call(commands.syncRecover(url, allowHttp, username, recoveryCode, newPassword, deviceName)),
    listDevices: () => call(commands.syncListDevices()),
    disconnectDevice: async (deviceId) => {
      await call(commands.syncDisconnectDevice(deviceId))
    },
    signOut: () => call(commands.syncSignOut()),
    saveRecoveryCode: async (contents) => {
      let result: Result<string | null, string>
      try {
        result = await commands.exportTextFile(contents, RECOVERY_CODE_FILE_NAME)
      } catch {
        throw new SyncPortError("ipc_failed")
      }
      if (result.status === "ok") return result.data
      // The text of a file error may name a path: only the code is kept.
      throw new SyncPortError("storage_error")
    },
    vaultStatus: async () => {
      try {
        return await commands.syncVaultStatus()
      } catch {
        throw new SyncPortError("ipc_failed")
      }
    },
    listSpaces: () => call(commands.syncListSpaces()),
    enableVault: (target, testVault) => call(commands.syncEnableVault(target, testVault)),
    disableVault: () => call(commands.syncDisableVault()),
    runNow: async () => {
      await call(commands.syncRunNow())
    },
    approve: async (kind) => {
      await call(commands.syncApprove(kind))
    },
    resolveConflict: async (id, choice) => {
      await call(commands.syncResolveConflict(id, choice))
    },
    readConflictVersions: (id) => call(commands.syncReadConflictVersions(id)),
    resolveConflictWithText: async (id, text, stamp) => {
      await call(commands.syncResolveConflictWithText(id, text, stamp))
    },
    onVaultStatus: async (listener) => {
      try {
        const { listen } = await import("@tauri-apps/api/event")
        const unlisten = await listen<VaultSyncStatus>(VAULT_STATUS_EVENT, (event) =>
          listener(event.payload),
        )
        return () => unlisten()
      } catch {
        throw new SyncPortError("ipc_failed")
      }
    },
    onRemoteDeleted: async (listener) => {
      try {
        const { listen } = await import("@tauri-apps/api/event")
        const unlisten = await listen<RemoteDeletedEvent>(REMOTE_DELETED_EVENT, (event) =>
          listener(event.payload),
        )
        return () => unlisten()
      } catch {
        throw new SyncPortError("ipc_failed")
      }
    },
    onRestoredAfterDeletion: async (listener) => {
      try {
        const { listen } = await import("@tauri-apps/api/event")
        const unlisten = await listen<string[]>(RESTORED_AFTER_DELETION_EVENT, (event) =>
          listener(event.payload),
        )
        return () => unlisten()
      } catch {
        throw new SyncPortError("ipc_failed")
      }
    },
  }
}

const unavailable = (): Promise<never> => Promise.reject(new SyncPortError("unavailable"))

/** The port of the browser build: sync needs the desktop application. */
export const unavailableSyncPort: SyncPort = {
  status: async () => ({
    connected: false,
    keysMissing: false,
    pending: false,
    serverUrl: null,
    host: null,
    username: null,
    deviceId: null,
    allowHttp: false,
  }),
  checkServer: unavailable,
  checkPassword: unavailable,
  prepareAccount: unavailable,
  confirmRecoveryCode: unavailable,
  setEnrollCode: unavailable,
  cancelPending: async () => {},
  signIn: unavailable,
  recover: unavailable,
  listDevices: unavailable,
  disconnectDevice: unavailable,
  signOut: unavailable,
  saveRecoveryCode: unavailable,
  vaultStatus: async () => ({
    enabled: false,
    linked: false,
    resumable: false,
    testVault: false,
    gateClosed: true,
    spaceId: null,
    spaceName: null,
    phase: "off",
    lastSyncMs: null,
    nextTrySecs: null,
    errorCode: null,
    stop: null,
    outgoingPaused: false,
    needsUpdate: false,
    conflicts: [],
    unsynced: [],
    itemErrors: 0,
    last: null,
  }),
  listSpaces: unavailable,
  enableVault: unavailable,
  disableVault: unavailable,
  runNow: unavailable,
  approve: unavailable,
  resolveConflict: unavailable,
  readConflictVersions: unavailable,
  resolveConflictWithText: unavailable,
  onVaultStatus: async () => () => {},
  onRemoteDeleted: async () => () => {},
  onRestoredAfterDeletion: async () => () => {},
}

let desktopPort: SyncPort | null = null

/** The desktop port in the application, the unavailable one in a browser. */
export function resolveSyncPort(): SyncPort {
  if (!isTauri()) return unavailableSyncPort
  desktopPort ??= createDesktopSyncPort()
  return desktopPort
}
