import { isPathInside } from "../workspace-mutations"

/**
 * Paths Amby itself deleted (to the trash) while their editor was open. The closing editor, or
 * one that is handed an empty value because its buffer is gone, still reports a change for such a
 * path. That change must go nowhere: the compare-and-swap write would fail on the missing file
 * and ask "overwrite the file changed outside Amby?", and answering yes would recreate the file
 * the person just deleted. Opening the path again (restored from the trash, created anew) lifts it.
 */
export class DeletedPaths {
  private readonly roots = new Set<string>()

  add(root: string): void {
    this.roots.add(root)
  }

  covers(path: string): boolean {
    for (const root of this.roots) if (isPathInside(path, root)) return true
    return false
  }

  /** The path is open again: stop dropping its saves. */
  lift(path: string): void {
    for (const root of [...this.roots]) if (isPathInside(path, root)) this.roots.delete(root)
  }

  clear(): void {
    this.roots.clear()
  }
}
