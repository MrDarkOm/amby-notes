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

/** A message for the user; the Rust payload picks the kind, the interface words it. */
export function projectErrorText(t: TFunction, error: unknown): string {
  if (!(error instanceof ProjectOperationError) || !error.error) {
    return error instanceof Error ? error.message : String(error)
  }
  const payload = error.error
  switch (payload.kind) {
    case "invalidName": {
      const key = NAME_REASONS[payload.reason]
      return key
        ? t(`creative.errors.nameReason.${key}`)
        : t("creative.errors.invalidName", { reason: payload.reason })
    }
    case "pathCollision":
      return t("creative.errors.pathCollision", { path: payload.path })
    case "workshopNotFound":
    case "storyNotFound":
      return t("creative.errors.projectNotFound")
    case "workshopReadOnly":
    case "storyReadOnly":
      return t("creative.errors.projectReadOnly")
    case "revisionConflict":
      return t("creative.errors.revisionConflict")
    case "rolledBack":
      return t("creative.errors.rolledBack", { message: payload.message })
    case "recoveryRequired":
      return t("creative.errors.recoveryRequired", { message: payload.message })
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
      return t("creative.errors.generic", { message: `Level in use: ${payload.count}` })
    case "unsupportedPreset":
      return t("creative.errors.unsupportedPreset")
    case "unsupportedRole":
    case "invalidOperationId":
    case "operationIdReused":
    case "failed":
      return t("creative.errors.generic", { message: error.message })
  }
}
