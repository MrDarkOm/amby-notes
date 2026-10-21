import { describe, expect, it } from "vitest"
import i18n from "@/lib/i18n"
import { KNOWN_SYNC_ERROR_CODES, formatWait, syncErrorKey, syncErrorMessage } from "./sync-errors"
import { SyncPortError } from "./sync-port"

const t = i18n.t.bind(i18n)

/** Table Б.0.1 and the codes of the client and of the application (docs/sync-plan.md). */
const EXPECTED_CODES = [
  // table Б.0.1 (what the sign-in screen can meet)
  "bad_request",
  "unauthorized",
  "token_revoked",
  "invalid_credentials",
  "invalid_enroll_code",
  "enroll_code_expired",
  "invalid_proof",
  "not_found",
  "keys_conflict",
  "payload_too_large",
  "rate_limited",
  "internal",
  "not_implemented",
  // the client
  "invalid_url",
  "insecure_url",
  "invalid_username",
  "invalid_device_name",
  "network",
  "timeout",
  "bad_response",
  "server_unavailable",
  "unsupported_server",
  "cannot_decrypt",
  "crypto",
  // the application
  "weak_password",
  "password_too_short",
  "no_pending_account",
  "recovery_confirmation_mismatch",
  "invalid_recovery_code",
  "not_connected",
  "already_connected",
  "keychain_unavailable",
  "storage_error",
  "unavailable",
  "ipc_failed",
]

describe("texts of sync errors", () => {
  it("knows every code of the table and of the application", () => {
    for (const code of EXPECTED_CODES) expect(KNOWN_SYNC_ERROR_CODES, code).toContain(code)
  })

  it("has a text in Russian and in English for each known code, and the texts differ", async () => {
    expect(KNOWN_SYNC_ERROR_CODES.length).toBeGreaterThanOrEqual(EXPECTED_CODES.length)
    for (const language of ["ru", "en"]) {
      await i18n.changeLanguage(language)
      const seen = new Map<string, string>()
      for (const code of KNOWN_SYNC_ERROR_CODES) {
        const key = syncErrorKey(code)
        expect(i18n.exists(key, { lng: language }), `${language}: ${key}`).toBe(true)
        const text = t(key, { count: 5 })
        expect(text.length).toBeGreaterThan(8)
        expect(text, `${language}: ${code} must not show a code`).not.toContain("_")
        const same = seen.get(text)
        expect(same, `${language}: ${code} repeats the text of ${same}`).toBeUndefined()
        seen.set(text, code)
      }
    }
    await i18n.changeLanguage("ru")
  })

  it("tells the person what to do for the common failures", async () => {
    await i18n.changeLanguage("ru")
    expect(syncErrorMessage(new SyncPortError("network"), t)).toContain(
      "Не удалось связаться с сервером",
    )
    expect(syncErrorMessage(new SyncPortError("insecure_url"), t)).toContain("https://")
    expect(syncErrorMessage(new SyncPortError("invalid_credentials"), t)).toContain("Неверное имя")
    expect(syncErrorMessage(new SyncPortError("weak_password"), t)).toContain("слишком простой")
  })

  it("says how long to wait after a rate limit", async () => {
    await i18n.changeLanguage("ru")
    const text = syncErrorMessage(new SyncPortError("rate_limited", 840), t)
    expect(text).toContain("14 мин")
    expect(syncErrorMessage(new SyncPortError("rate_limited", null), t).length).toBeGreaterThan(10)
  })

  it("writes a wait in the largest sensible unit", () => {
    expect(formatWait(45, t)).toBe("45 с")
    expect(formatWait(60, t)).toBe("1 мин")
    expect(formatWait(840, t)).toBe("14 мин")
    expect(formatWait(3600, t)).toBe("1 ч")
    expect(formatWait(5400, t)).toBe("2 ч")
    expect(formatWait(0, t)).toBe("1 с")
  })

  it("shows the code for a code it does not know, never the text of a server", async () => {
    await i18n.changeLanguage("ru")
    const unknown = syncErrorMessage(new SyncPortError("a_code_of_a_newer_server"), t)
    expect(unknown).toContain("a_code_of_a_newer_server")
    expect(syncErrorKey("a_code_of_a_newer_server")).toBe(syncErrorKey("another_unknown_code"))
    const other = syncErrorMessage(new Error("CLICK http://evil.example"), t)
    expect(other).not.toContain("evil")
  })
})
