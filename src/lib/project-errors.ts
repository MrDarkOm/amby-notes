import type { TFunction } from "i18next"
import { ProjectOperationError } from "@/lib/storage"

const NAME_REASONS: Record<string, string> = {
  empty: "empty",
  "too long": "tooLong",
  hidden: "hidden",
  "trailing dot": "trailingDot",
  "forbidden character": "forbiddenCharacter",
  "reserved name": "reservedName",
  duplicate: "duplicate",
  invalid: "invalid",
  "too many": "tooMany",
  "too large": "tooLarge",
}

/** `failed` codes the interface has its own text for; any other one has the general text. */
const FAILED_TEXTS: Record<string, string> = {
  folderNotEmpty: "creative.errors.folderNotEmpty",
  sectionAlreadyExists: "creative.errors.sectionAlreadyExists",
  interrupted: "creative.errors.interrupted",
  // a workshop or story file that cannot be read or does not parse
  invalidWorkshopFile: "creative.errors.fileDamaged",
  parseManifest: "creative.errors.fileDamaged",
  parseStoryFile: "creative.errors.fileDamaged",
  readManifest: "creative.errors.fileDamaged",
  readStoryFile: "creative.errors.fileDamaged",
  storyFormat: "creative.errors.fileDamaged",
  textSchemaBroken: "creative.errors.fileDamaged",
  missingStoriesSection: "creative.errors.fileDamaged",
  missingStoriesDir: "creative.errors.fileDamaged",
  projectJournal: "creative.errors.journalProblem",
}

/** The last part of a path: the name a person knows the item by. */
function nameOf(path: string): string {
  const parts = path.split(/[\\/]/u).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** The stable code of a project failure: its kind, or the code of an unclassified failure. */
export function projectErrorCode(error: ProjectOperationError): string {
  const payload = error.error
  if (payload?.kind === "failed") return payload.code
  return payload?.kind ?? error.kind
}

/**
 * A message for the user; the Rust payload picks the kind, the interface words it. What the
 * backend wrote in `message` is for the logs and is never shown (docs/notices.md §10).
 */
export function projectErrorText(t: TFunction, error: unknown): string {
  if (!(error instanceof ProjectOperationError) || !error.error) {
    return t("creative.errors.generic", {
      code: error instanceof ProjectOperationError ? projectErrorCode(error) : "unknown",
    })
  }
  const payload = error.error
  switch (payload.kind) {
    case "invalidName": {
      const key = NAME_REASONS[payload.reason]
      return key ? t(`creative.errors.nameReason.${key}`) : t("creative.errors.invalidName")
    }
    case "pathCollision":
      return t("creative.errors.pathCollision", { name: nameOf(payload.path) })
    case "workshopNotFound":
    case "storyNotFound":
      return t("creative.errors.projectNotFound")
    case "workshopReadOnly":
    case "storyReadOnly":
      return t("creative.errors.projectReadOnly")
    case "revisionConflict":
      return t("creative.errors.revisionConflict")
    case "rolledBack":
      return t("creative.errors.rolledBack")
    case "recoveryRequired":
      return t("creative.errors.recoveryRequired")
    case "moduleDisabled":
      return t("creative.errors.moduleDisabled")
    case "vaultNotOpen":
    case "vaultGenerationConflict":
      return t("creative.errors.vaultChanged")
    case "invalidParent":
      return t("creative.errors.invalidParent")
    case "sectionNotFound":
      return t("creative.errors.sectionNotFound")
    case "cannotRemoveStoriesSection":
    case "cannotRemoveTextSection":
      return t("creative.errors.cannotRemoveTextSection")
    case "textNotConfigured":
      return t("creative.errors.textNotConfigured")
    case "statusAlreadyConfigured":
      return t("creative.errors.statusAlreadyConfigured")
    case "storyLinksAlreadyConfigured":
      return t("creative.errors.storyLinksAlreadyConfigured")
    case "storyLinksUnavailable":
      return t("creative.errors.storyLinksUnavailable")
    case "unknownTextLevel":
      return t("creative.errors.unknownTextLevel")
    case "unknownTextFormat":
      return t("creative.errors.unknownTextFormat")
    case "invalidOrderKey":
    case "pageNotFound":
      return t("creative.errors.pageNotFound")
    case "parentCycle":
      return t("creative.errors.parentCycle")
    case "parentLevelNotShallower":
      return t("creative.errors.parentLevelNotShallower")
    case "levelInUse":
      return t("creative.errors.levelInUse", { count: payload.count })
    case "unsupportedPreset":
      return t("creative.errors.unsupportedPreset")
    case "failed": {
      const key = FAILED_TEXTS[payload.code]
      return key ? t(key) : t("creative.errors.generic", { code: payload.code })
    }
    case "unsupportedRole":
    case "invalidOperationId":
    case "operationIdReused":
      return t("creative.errors.generic", { code: payload.kind })
  }
}
