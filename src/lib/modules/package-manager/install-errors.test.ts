import { describe, expect, it } from "vitest"
import i18n from "@/lib/i18n"
import {
  InvalidPackageError,
  installFailureCode,
  installFailureText,
  reportInstallFailure,
} from "./install-errors"
import type { InstallErrorCode } from "./types"

const CODES: InstallErrorCode[] = [
  "CATALOG_ERROR",
  "INCOMPATIBLE_VERSION",
  "UNSATISFIED_DEPENDENCIES",
  "PATH_TRAVERSAL",
  "CHECKSUM_MISMATCH",
  "INVALID_SIGNATURE",
  "STAGING_FAILED",
  "PUBLISH_FAILED",
  "UNINSTALL_FAILED",
  "INVALID_PACKAGE",
]

describe("text of a failed package operation (docs/notices.md §10)", () => {
  it.each(CODES)("has its own text for %s, in both languages", async (code) => {
    for (const language of ["ru", "en"]) {
      const t = i18n.getFixedT(language)
      const text = installFailureText(code, t)
      expect(text).not.toContain("settings.modules.packages.failures")
      expect(text.length).toBeGreaterThan(20)
    }
  })

  it("gives the general text and the code for a code it does not know", () => {
    const text = installFailureText("SOMETHING_NEW", i18n.getFixedT("en"))
    expect(text).toContain("SOMETHING_NEW")
  })

  it("takes the code from the result or from the kind of a thrown error, never from its words", () => {
    expect(installFailureCode("CHECKSUM_MISMATCH")).toBe("CHECKSUM_MISMATCH")
    expect(installFailureCode(undefined)).toBe("unknown")
    expect(installFailureCode(new InvalidPackageError())).toBe("INVALID_PACKAGE")
    expect(installFailureCode(new SyntaxError("Unexpected token } in JSON"))).toBe(
      "INVALID_PACKAGE",
    )
    expect(installFailureCode(new Error("PATH_TRAVERSAL: /etc/passwd"))).toBe("unknown")
  })

  it("never shows what the package or the backend said", () => {
    const raw = "ENOENT: /Users/alice/.amby/modules/secret/manifest.json"
    const text = reportInstallFailure("STAGING_FAILED", raw)
    expect(text).not.toContain("alice")
    expect(text).not.toContain("ENOENT")
    expect(reportInstallFailure(new Error(raw))).not.toContain("alice")
  })
})
