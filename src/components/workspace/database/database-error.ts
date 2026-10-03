import type { TFunction } from "i18next"

/** What was being changed, which decides how a refusal is worded. */
export type SchemaChange = "type" | "relation" | "date"

/**
 * The reason a schema change was refused, in the user's language. The backend reports it in
 * English; the ones a person can act on are explained here, others are shown as they are.
 */
export function databaseErrorText(error: unknown, t: TFunction, change: SchemaChange): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes("existing values are cleared")) {
    return t(
      change === "relation"
        ? "databaseErrors.relationValues"
        : change === "date"
          ? "databaseErrors.dateValues"
          : "databaseErrors.typeValues",
    )
  }
  if (message.includes("Manifest revision conflict")) return t("databaseErrors.changedElsewhere")
  if (message.includes("another property depends on it")) return t("databaseErrors.hasDependents")
  return message
}
