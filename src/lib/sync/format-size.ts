// Sizes of the plans and of the storages in decimal units, like Finder (docs/sync-plan.md,
// appendix Е, У2): 1 KB is 1000 bytes, never 1024.

/**
 * STUB of the red-tests step of appendix Е. The rule the tests fix: bytes under 1000 as
 * "950 B"; from there the largest unit that keeps the number at least 1 (KB, MB, GB, TB), one
 * decimal while the number is under 10 (a trailing ".0" is dropped), none from 10 up, rounded to
 * the nearest; the decimal separator and the unit names follow `language` ("1,5 МБ" in Russian,
 * "1.5 MB" in English).
 */
export function formatSize(bytes: number, language: string): string {
  void bytes
  void language
  throw new Error("not_implemented: formatSize")
}
