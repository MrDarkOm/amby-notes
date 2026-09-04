import { findModule, type ModuleContext } from "./modules"

/** A transition can flush pending work before changing visible module state. */
export interface ModuleLifecycleResult {
  ok: true
}

export interface ModuleLifecycleFailure {
  ok: false
  error: unknown
}

/**
 * Prepare all modules that are about to be disabled. No state or layout
 * mutation belongs in this phase: if any participant rejects its flush, the
 * caller can leave the current module set untouched.
 */
export async function prepareModuleDeactivation(
  previous: string[],
  next: string[],
  context: ModuleContext,
): Promise<void> {
  const nextSet = new Set(next)
  for (const id of previous) {
    if (!nextSet.has(id)) await findModule(id)?.prepareDeactivate?.(context)
  }
}

/** Commit hooks only after every deactivation participant has prepared. */
export function commitModuleLifecycle(
  previous: string[],
  next: string[],
  context: ModuleContext,
): void {
  const previousSet = new Set(previous)
  const nextSet = new Set(next)
  for (const id of previous) {
    if (!nextSet.has(id)) findModule(id)?.onDeactivate?.(context)
  }
  for (const id of next) {
    if (!previousSet.has(id)) findModule(id)?.onActivate?.(context)
  }
}

/** Run the two-phase transition and turn a failed flush into a typed result. */
export async function transitionModuleLifecycle(
  previous: string[],
  next: string[],
  context: ModuleContext,
): Promise<ModuleLifecycleResult | ModuleLifecycleFailure> {
  try {
    await prepareModuleDeactivation(previous, next, context)
  } catch (error) {
    return { ok: false, error }
  }
  commitModuleLifecycle(previous, next, context)
  return { ok: true }
}
