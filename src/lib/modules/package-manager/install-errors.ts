// The text a person reads when installing, updating, rolling back or removing a module fails, chosen
// by the code of the failure (docs/notices.md §10). What the installer, the backend or a package said
// is for the debug log, never for the screen: a package comes from outside, so its words are not ours.

import type { TFunction } from "i18next"
import i18n from "@/lib/i18n"
import { logger } from "@/lib/logger"
import type { InstallErrorCode } from "./types"

/** The file or the answer is not a module package at all (no manifest in it, not JSON). */
export class InvalidPackageError extends Error {
  readonly code = "INVALID_PACKAGE" as const
  constructor() {
    super("Invalid package")
    this.name = "InvalidPackageError"
  }
}

const KNOWN: ReadonlySet<string> = new Set<InstallErrorCode>([
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
])

/** The code of a failure: the code the installer gave, the kind of a thrown error, or `unknown`. */
export function installFailureCode(failure: unknown): string {
  if (typeof failure === "string") return KNOWN.has(failure) ? failure : "unknown"
  if (failure instanceof InvalidPackageError || failure instanceof SyntaxError) {
    return "INVALID_PACKAGE"
  }
  return "unknown"
}

/** The text for a code, from the dictionary; an unknown code gets the general text and the code. */
export function installFailureText(code: string, t: TFunction = i18n.t.bind(i18n)): string {
  if (KNOWN.has(code)) return t(`settings.modules.packages.failures.${code}`)
  return t("settings.modules.packages.failures.general", { code })
}

/**
 * The text of a failed package operation, and a line in the debug log with its code (§13). `failure`
 * is the code from an `InstallResult` or whatever was thrown; the raw text only goes to the log.
 */
export function reportInstallFailure(failure: unknown, raw?: unknown): string {
  const code = installFailureCode(failure)
  logger.warn("modules.install_failed", { failureCode: code, error: raw ?? failure })
  return installFailureText(code)
}
