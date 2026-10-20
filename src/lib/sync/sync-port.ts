// Boundary between the interface and the sync commands of the Rust side (docs/sync-plan.md,
// stage Э4, the connect screen). The UI talks to a `SyncPort`; the desktop port calls the
// generated commands, the browser port refuses. Every failure is a `SyncPortError` with the
// machine code of the Rust side — the UI translates the code (sync-errors.ts), never a text.

import type {
  DeviceView,
  PasswordCheck,
  PreparedAccountView,
  ServerCheck,
  SignOutResult,
  SyncStatus,
} from "@/lib/bindings"

export type {
  DeviceView,
  PasswordCheck,
  PreparedAccountView,
  ServerCheck,
  SignOutResult,
  SyncStatus,
}

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
export interface ServerTarget {
  url: string
  allowHttp: boolean
}

export interface PrepareAccountInput extends ServerTarget {
  username: string
  enrollCode: string
  password: string
  deviceName: string
}

export interface SignInInput extends ServerTarget {
  username: string
  password: string
  deviceName: string
}

export interface RecoverInput extends ServerTarget {
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

/** The port that calls the Rust commands. */
export function createDesktopSyncPort(): SyncPort {
  throw new Error("not implemented")
}

/** The port of the browser build: sync needs the desktop application. */
export const unavailableSyncPort: SyncPort = new Proxy({} as SyncPort, {
  get() {
    throw new Error("not implemented")
  },
})

/** The desktop port in the application, the unavailable one in a browser. */
export function resolveSyncPort(): SyncPort {
  throw new Error("not implemented")
}
