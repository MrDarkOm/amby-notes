/**
 * How a rename ended, for the field where the name was typed (docs/notices.md, section 8). `failed`
 * carries the text for the person, chosen by the error's code from the dictionary, never the error's own words.
 */
export type RenameOutcome =
  { status: "renamed" } | { status: "skipped" } | { status: "failed"; text: string }

/** The line to show under the name field, or nothing when the rename did not fail. */
export function renameFailureText(outcome: RenameOutcome | void): string | null {
  return outcome && outcome.status === "failed" ? outcome.text : null
}
