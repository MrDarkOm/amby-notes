import type { TFunction } from "i18next"
import { operationErrorText } from "@/lib/operation-errors"
import type { SchemaChange } from "@/lib/database-errors"

export type { SchemaChange }

/**
 * The reason a schema change was refused, in the user's language: chosen by the failure's code,
 * with a refusal because values exist worded by what was being changed.
 */
export function databaseErrorText(error: unknown, t: TFunction, change: SchemaChange): string {
  return operationErrorText(error, t, { change })
}
