export type EditorSurface = "document" | "databasePeek" | "databaseFullPage"

export interface EditorSurfaceLease {
  noteId: string
  owner: EditorSurface
  token: string
}

/** One writable editor surface per note; read-only surfaces do not acquire it. */
export class EditorSurfaceLeaseManager {
  private leases = new Map<string, EditorSurfaceLease>()

  acquire(noteId: string, owner: EditorSurface, token: string): boolean {
    const current = this.leases.get(noteId)
    if (current && current.token !== token) return false
    this.leases.set(noteId, { noteId, owner, token })
    return true
  }

  release(noteId: string, token: string): void {
    if (this.leases.get(noteId)?.token === token) this.leases.delete(noteId)
  }

  owner(noteId: string): EditorSurface | null {
    return this.leases.get(noteId)?.owner ?? null
  }
}
