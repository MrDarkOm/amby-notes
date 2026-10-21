// Boundary between the interface and the sync commands of the Rust side (docs/sync-plan.md,
// stage Э4, the connect screen). The UI talks to a `SyncPort`; the desktop port calls the
// generated commands, the browser port refuses. Every failure is a `SyncPortError` with the
// machine code of the Rust side — the UI translates the code (sync-errors.ts), never a text.

import { commands } from "@/lib/bindings"
import { isTauri } from "@/lib/storage"
import type {
  Result,
  SyncError,
  DeviceView,
  PasswordCheck,
  PreparedAccountView,
  ServerCheck,
  SignOutResult,
  SyncStatus,
} from "@/lib/bindings"

export type { DeviceView, PasswordCheck, PreparedAccountView, ServerCheck, SyncStatus }

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
}

let desktopPort: SyncPort | null = null

/** The desktop port in the application, the unavailable one in a browser. */
export function resolveSyncPort(): SyncPort {
  if (!isTauri()) return unavailableSyncPort
  desktopPort ??= createDesktopSyncPort()
  return desktopPort
}
