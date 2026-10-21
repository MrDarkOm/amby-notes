// A sync port for tests: every method is a `vi.fn` with a believable answer. Test code only.

import { vi, type Mock } from "vitest"
import {
  SyncPortError,
  type DeviceView,
  type PasswordCheck,
  type SyncPort,
  type SyncStatus,
} from "@/lib/sync/sync-port"

/** The 14 groups of the recovery code the fake shows. */
export const FAKE_CODE_GROUPS = [
  "1111",
  "2222",
  "3333",
  "4444",
  "5555",
  "6666",
  "7777",
  "8888",
  "9999",
  "AAAA",
  "BBBB",
  "CCCC",
  "DDDD",
  "EEEE",
]
export const FAKE_CODE = FAKE_CODE_GROUPS.join("-")
/** The groups the fake asks to type back (1-based). */
export const FAKE_CONFIRM_GROUPS = [3, 9]

export const DISCONNECTED: SyncStatus = {
  connected: false,
  keysMissing: false,
  pending: false,
  serverUrl: null,
  host: null,
  username: null,
  deviceId: null,
  allowHttp: false,
}

export const CONNECTED: SyncStatus = {
  connected: true,
  keysMissing: false,
  pending: false,
  serverUrl: "https://sync.example.com",
  host: "sync.example.com",
  username: "alice",
  deviceId: "d1",
  allowHttp: false,
}

export const DEVICES: DeviceView[] = [
  {
    deviceId: "d1",
    name: "Mac mini",
    createdMs: 1_760_000_000_000,
    lastSeenMs: 1_760_000_100_000,
    current: true,
  },
  {
    deviceId: "d2",
    name: "Ноутбук",
    createdMs: 1_760_000_200_000,
    lastSeenMs: 1_760_000_300_000,
    current: false,
  },
  {
    deviceId: "d3",
    name: null,
    createdMs: 1_760_000_400_000,
    lastSeenMs: 1_760_000_500_000,
    current: false,
  },
]

/** The fake's rule: under 12 characters is too short, a few well-known words are weak. */
export function fakePasswordCheck(password: string): PasswordCheck {
  const length = [...password].length
  const tooShort = length < 12
  const weak = /password|12345|qwerty/i.test(password)
  const score = tooShort ? 1 : weak ? 1 : length > 20 ? 4 : 3
  return {
    ok: !tooShort && !weak,
    score,
    length,
    minLength: 12,
    tooShort,
    warning: weak ? "common_password" : null,
    suggestions: [],
  }
}

export type FakePort = { [K in keyof SyncPort]: Mock<SyncPort[K]> }

export function createFakePort(overrides: Partial<SyncPort> = {}): FakePort {
  const port: SyncPort = {
    status: async () => DISCONNECTED,
    checkServer: async ({ url }) => ({
      url,
      host: "sync.example.com",
      serverVersion: "0.1.0",
      instanceId: "00112233445566778899aabbccddeeff",
    }),
    checkPassword: async (password) => fakePasswordCheck(password),
    prepareAccount: async () => ({ recoveryCode: FAKE_CODE, confirmGroups: FAKE_CONFIRM_GROUPS }),
    confirmRecoveryCode: async (groups) => {
      const typed = groups.map((group) => group.trim().toUpperCase())
      const expected = FAKE_CONFIRM_GROUPS.map((position) => FAKE_CODE_GROUPS[position - 1])
      if (typed.length === 2 && typed[0] === expected[0] && typed[1] === expected[1])
        return CONNECTED
      throw new SyncPortError("recovery_confirmation_mismatch")
    },
    setEnrollCode: async () => {},
    cancelPending: async () => {},
    signIn: async () => CONNECTED,
    recover: async () => CONNECTED,
    listDevices: async () => DEVICES,
    disconnectDevice: async () => {},
    signOut: async () => ({ serverNotified: true }),
    saveRecoveryCode: async () => "/Users/alice/amby-recovery-code.txt",
    ...overrides,
  }
  const wrapped = {} as FakePort
  for (const key of Object.keys(port) as Array<keyof SyncPort>) {
    ;(wrapped as Record<string, unknown>)[key] = vi.fn(port[key] as (...args: never[]) => unknown)
  }
  return wrapped
}
