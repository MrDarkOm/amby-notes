/**
 * Installed (package-manager) modules are third-party JavaScript. Until they run
 * in a real isolation boundary (a Worker prototype does not prove one, see
 * docs/claude-handoff.md stage 6) they must not be imported into the privileged
 * renderer. Official modules are bundled statically and are unaffected.
 *
 * Flip this only together with a verified isolation runtime and packaged-CSP
 * checks; it is intentionally a code constant, not a user setting.
 */
export const INSTALLED_MODULE_EXECUTION_ENABLED = false

export function canExecuteInstalledModules(): boolean {
  return INSTALLED_MODULE_EXECUTION_ENABLED
}
