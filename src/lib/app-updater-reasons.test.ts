// Why an update could not be installed, told as a code the journal keeps (docs/notices.md): on
// 13 November the installed beta could not install the next one and the journal had nothing but
// "Error". The texts below are those of the updater plugin. Written before the code.
import { describe, expect, it } from "vitest"
import { sanitizeLogMetadata } from "@/lib/debug/privacy"
import { updateFailureCode } from "./app-updater"

const cases: Array<[string, string]> = [
  ["Permission denied (os error 13)", "PermissionDenied"],
  ["Operation not permitted (os error 1)", "PermissionDenied"],
  [
    "failed to install the update: the previous app could not be restored, kept at /x",
    "PreviousAppNotRestored",
  ],
  ["Temp directory is not on the same mount point as the AppImage", "TempDirNotOnSameMountPoint"],
  ["Signature verification failed: Invalid signature", "SignatureInvalid"],
  // tauri-plugin-updater 2.14: the version in the signature is not the version the feed announced
  // (beta 4 → beta 5 on 13 November), or the signature names no version at all.
  [
    "The update was signed for version 0.1.9 but the update endpoint announced version 0.1.9-beta.5. The endpoint response may have been tampered with to force installing a different release.",
    "SignedVersionMismatch",
  ],
  [
    "The update signature does not specify the version it was signed for, which `requireSignedVersion` requires. Re-sign and re-publish this release, or disable `requireSignedVersion`.",
    "SignedVersionMissing",
  ],
  ["error sending request for url (https://api.github.com/...)", "NetworkError"],
  ["operation timed out", "NetworkError"],
  ["something else entirely", "UnknownError"],
]

describe("the cause of a failed update install", () => {
  for (const [message, code] of cases) {
    it(`"${message}" is ${code}`, () => {
      expect(updateFailureCode(new Error(message))).toBe(code)
      expect(updateFailureCode(message)).toBe(code)
    })
  }

  it("never carries the text or a path of the error", () => {
    const code = updateFailureCode(new Error("Permission denied at /Applications/Amby.app"))
    expect(code).not.toMatch(/Applications|Amby/)
  })

  it("passes the privacy filter of the journal as it is", () => {
    for (const code of new Set(cases.map(([, value]) => value))) {
      expect(sanitizeLogMetadata({ failureCode: code })?.failureCode).toBe(code)
    }
  })
})
