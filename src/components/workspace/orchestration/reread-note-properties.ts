/**
 * Rereads the properties of the open notes after another computer changed them (docs/sync-plan.md,
 * З65). Red stub: the real code follows the tests.
 */
export function touchesNoteProperties(_paths: string[]): boolean {
  return false
}

export async function rereadOpenNoteProperties(
  _vault: string,
  _generation: number,
): Promise<void> {}
