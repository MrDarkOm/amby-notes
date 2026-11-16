/**
 * Whether a person-typed name for a new or renamed item is safe in a vault that other
 * systems share. Mirrors `validate_item_name` in `src-tauri/src/bundle/path_ops.rs` so the
 * browser fallback refuses the same names as the desktop backend (CORE-14).
 */
const MAX_ITEM_NAME_BYTES = 200
const SERVICE_NAMES = new Set([".git", ".amby", ".obsidian", ".trash", ".ds_store"])
const DEVICE_NAME = /^(?:con|prn|aux|nul|(?:com|lpt)[1-9])$/u
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
const FORBIDDEN_CHARACTER = /[\u0000-\u001f\u007f-\u009f/\\:<>"|?*‪-‮⁦-⁩]/u

export function isValidItemName(rawName: string): boolean {
  const name = rawName.trim()
  if (!name || new TextEncoder().encode(name).length > MAX_ITEM_NAME_BYTES) return false
  if (FORBIDDEN_CHARACTER.test(name)) return false
  if (/^\.+$/u.test(name) || name.endsWith(".")) return false
  const lower = name.toLowerCase()
  if (SERVICE_NAMES.has(lower)) return false
  return !DEVICE_NAME.test(lower.split(".")[0] ?? "")
}
