// Boundary between the interface and the commands of the new storage of note properties
// (docs/sync-plan.md, appendix З): the panel of a note with its sleeping records and the hint
// about a rename, the migration from `properties.json`, and the edits of an old version.
// The desktop port calls the generated commands; in the browser there is no such storage and
// every function answers `null`.

import { commands } from "@/lib/bindings"
import type {
  MigrationOutcomeView,
  MigrationReportView,
  OldVersionReport,
  PropertyPanel,
  PropertyStorageStatus,
  RenameHintView,
} from "@/lib/bindings"
import { isTauri } from "@/lib/storage"
import { unwrapCommand } from "@/lib/storage/ipc-result"

export type {
  MigrationOutcomeView,
  MigrationReportView,
  OldVersionReport,
  PropertyPanel,
  PropertyStorageStatus,
  RenameHintView,
}

/** Where the properties of the open vault live; `null` outside the desktop application. */
export async function propertyStorageStatus(): Promise<PropertyStorageStatus | null> {
  if (!isTauri()) return null
  return unwrapCommand<PropertyStorageStatus>(commands.propertyStorageStatus())
}

/** The panel of a note: its properties, the sleeping records and the hint (З3, З3а, З46). */
export async function getPropertyPanel(noteId: string): Promise<PropertyPanel | null> {
  if (!isTauri()) return null
  return unwrapCommand<PropertyPanel>(commands.getPropertyPanel(noteId))
}

/** «Вернуть»: the key goes back into the header with an empty value (З3). */
export async function restoreDormantProperty(noteId: string, name: string): Promise<void> {
  if (!isTauri()) return
  await unwrapCommand(commands.restoreDormantProperty(noteId, name))
}

/** «Удалить окончательно»: a copy is kept in `.amby/property-backups/` first (З3, З34). */
export async function purgeDormantProperty(noteId: string, name: string): Promise<void> {
  if (!isTauri()) return
  await unwrapCommand(commands.purgeDormantProperty(noteId, name))
}

/** The owner agrees that a renamed key keeps the type and the icon of the old one (З3а). */
export async function acceptPropertyRenameHint(
  noteId: string,
  hint: RenameHintView,
): Promise<void> {
  if (!isTauri()) return
  await unwrapCommand(commands.acceptPropertyRenameHint(noteId, hint))
}

/** The owner refuses the hint; the refusal is stored in the record of the note (З44). */
export async function dismissPropertyRenameHint(
  noteId: string,
  hint: RenameHintView,
): Promise<void> {
  if (!isTauri()) return
  await unwrapCommand(commands.dismissPropertyRenameHint(noteId, hint))
}

/** The dry run of the migration: nothing is written (З19). */
export async function previewPropertiesMigration(): Promise<MigrationReportView | null> {
  if (!isTauri()) return null
  return unwrapCommand<MigrationReportView>(commands.previewPropertiesMigration())
}

/** The migration after the owner of the vault confirmed it (З21, З38). */
export async function runPropertiesMigration(): Promise<MigrationOutcomeView | null> {
  if (!isTauri()) return null
  return unwrapCommand<MigrationOutcomeView>(commands.runPropertiesMigration([]))
}

/** Carries over what an old version of Amby changed in `properties.json` (З22, З36). */
export async function checkOldVersionPropertyEdits(): Promise<OldVersionReport | null> {
  if (!isTauri()) return null
  return unwrapCommand<OldVersionReport>(commands.checkOldVersionPropertyEdits())
}

/** Settles a note changed both here and by an old version: keep the local look or take the old one (З22). */
export async function resolveOldVersionPropertyConflict(
  noteId: string,
  keepHere: boolean,
): Promise<void> {
  if (!isTauri()) return
  await unwrapCommand(commands.resolveOldVersionPropertyConflict(noteId, keepHere))
}
