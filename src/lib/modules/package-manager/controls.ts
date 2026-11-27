/**
 * Whether the settings page shows the package row of a module (install, remove, export,
 * size, version, update check). Switched off while only the built-in modules exist and the
 * on/off switch is all a person needs; the row and its code stay and come back by flipping this.
 *
 * While it is off, a built-in module can no longer be uninstalled, so one that an earlier
 * version uninstalled is brought back instead of staying out of reach.
 */
export const MODULE_PACKAGE_CONTROLS_ENABLED: boolean = false
