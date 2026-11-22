import type { FsMutationResult } from "./types"

/** A note in the templates folder: its name there without `.md`, and its vault path. */
export interface NoteTemplate {
  name: string
  path: string
}

/** Today's note: where it is, and the creation to apply to the tree when it was just made. */
export interface DailyNote {
  path: string
  created: boolean
  mutation: FsMutationResult | null
}

/**
 * The Templates and Daily notes modules (docs/vault-format.md, "Templates and daily notes").
 * Rust reads the module settings from `workspace.json`, renders the template (a fresh
 * `amby-id`, `{{title}}`, `{{date}}`, `{{time}}`) and creates the note through the regular
 * creation path; a switched-off module refuses with `moduleDisabled`.
 */
export interface NoteModulesPort {
  listNoteTemplates(): Promise<NoteTemplate[]>
  createNoteFromTemplate(
    parentPath: string,
    name: string,
    template: string,
  ): Promise<FsMutationResult>
  /** A new template in the templates folder (made when missing); never replaces one. */
  createNoteTemplate(name: string): Promise<FsMutationResult>
  /** Opens today's note, creating it (and its folder) when missing. */
  openDailyNote(): Promise<DailyNote>
}
