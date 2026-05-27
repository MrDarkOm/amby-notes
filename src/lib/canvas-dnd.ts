// Lightweight module-singleton bridging the sidebar tree's pointer-based drag
// to the Canvas. The tree drag does not use HTML5 dataTransfer, so we stash the
// dragged item here on drag-start and the canvas reads it on pointer-up.

export interface TreeDragPayload {
  id: string
  name: string
  path: string
}

let payload: TreeDragPayload | null = null

export function setTreeDragPayload(p: TreeDragPayload | null): void {
  payload = p
}

export function getTreeDragPayload(): TreeDragPayload | null {
  return payload
}

export function clearTreeDragPayload(): void {
  payload = null
}
