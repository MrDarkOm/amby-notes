export const MAIN_WINDOW_LABEL = "main"

export interface VaultActivatedPayload {
  path: string
  generation: number
}

export type VaultStartupPlan =
  { kind: "activate"; path: string } | { kind: "attach-active" } | { kind: "idle" }

export function ownsVaultWatcher(isDesktop: boolean, windowLabel: string): boolean {
  return isDesktop && windowLabel === MAIN_WINDOW_LABEL
}

export function ownsWorkspacePersistence(isDesktop: boolean, windowLabel: string): boolean {
  return !isDesktop || windowLabel === MAIN_WINDOW_LABEL
}

export function planVaultStartup({
  isDesktop,
  windowLabel,
  lastOpened,
  reopenLastVault,
}: {
  isDesktop: boolean
  windowLabel: string
  lastOpened: string | null
  reopenLastVault: boolean
}): VaultStartupPlan {
  if (isDesktop && windowLabel !== MAIN_WINDOW_LABEL) return { kind: "attach-active" }
  if (lastOpened && reopenLastVault) return { kind: "activate", path: lastOpened }
  if (!isDesktop) return { kind: "activate", path: "web-vault" }
  return { kind: "idle" }
}

export function activationMatchesCurrentVault(
  payload: VaultActivatedPayload,
  currentPath: string | null,
): boolean {
  return currentPath === payload.path
}
