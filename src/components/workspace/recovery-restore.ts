const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Determines whether the recovered draft and the disk content are the same document, avoiding false
 * positive recovery prompts. An "equal" draft is deleted without asking, so the comparison is exact:
 * only line endings are normalized; whitespace at the edges and a Sketch's `appState` still count.
 */
function isEffectivelyEmptyOrEquivalent(diskContent: string, recoveredContent: string): boolean {
  const normalizedDisk = diskContent.replace(/\r\n?/gu, "\n")
  const normalizedRec = recoveredContent.replace(/\r\n?/gu, "\n")
  if (normalizedDisk === normalizedRec) {
    return true
  }

  // Attempt JSON inspection for Canvas and Sketch documents.
  const trimmedDisk = normalizedDisk.trim()
  const trimmedRec = normalizedRec.trim()
  if (
    (trimmedDisk.startsWith("{") || trimmedDisk.startsWith("[")) &&
    (trimmedRec.startsWith("{") || trimmedRec.startsWith("["))
  ) {
    try {
      const diskJson = JSON.parse(trimmedDisk)
      const recJson = JSON.parse(trimmedRec)
      if (
        typeof diskJson === "object" &&
        diskJson !== null &&
        typeof recJson === "object" &&
        recJson !== null &&
        !Array.isArray(diskJson) &&
        !Array.isArray(recJson)
      ) {
        // 1. Canvas document check
        const isCanvas =
          "nodes" in diskJson || "edges" in diskJson || "nodes" in recJson || "edges" in recJson
        if (isCanvas) {
          const diskNodes = Array.isArray(diskJson.nodes) ? diskJson.nodes : []
          const diskEdges = Array.isArray(diskJson.edges) ? diskJson.edges : []
          const recNodes = Array.isArray(recJson.nodes) ? recJson.nodes : []
          const recEdges = Array.isArray(recJson.edges) ? recJson.edges : []
          // If both have 0 nodes and 0 edges, both are empty canvases.
          if (
            diskNodes.length === 0 &&
            diskEdges.length === 0 &&
            recNodes.length === 0 &&
            recEdges.length === 0
          ) {
            return true
          }
          if (
            JSON.stringify(diskNodes) === JSON.stringify(recNodes) &&
            JSON.stringify(diskEdges) === JSON.stringify(recEdges)
          ) {
            return true
          }
        }

        // 2. Sketch (Excalidraw) document check
        const isSketch =
          diskJson.type === "excalidraw" ||
          recJson.type === "excalidraw" ||
          "elements" in diskJson ||
          "elements" in recJson
        if (isSketch) {
          const diskElements = Array.isArray(diskJson.elements) ? diskJson.elements : []
          const recElements = Array.isArray(recJson.elements) ? recJson.elements : []
          // The view settings and embedded files are the person's too: they must match as well.
          const sameSettings =
            sameJson(diskJson.appState, recJson.appState) && sameJson(diskJson.files, recJson.files)
          if (sameSettings && sameJson(diskElements, recElements)) {
            return true
          }
        }
      }
    } catch {
      // Not valid JSON; fall through to standard string comparison
    }
  }

  return false
}

export function recoveryNeedsConfirmation(
  diskContent: string,
  recoveredContent: string | undefined,
): boolean {
  if (recoveredContent === undefined || recoveredContent === diskContent) {
    return false
  }
  if (isEffectivelyEmptyOrEquivalent(diskContent, recoveredContent)) {
    return false
  }
  return true
}

/**
 * Resolve a recovery draft only after its caller has compared it with the
 * authoritative on-disk content. The caller owns prompting and journal I/O;
 * this pure result keeps refusal from ever mutating the disk buffer.
 */
export function resolveRecoveryContent(
  diskContent: string,
  recoveredContent: string | undefined,
  restoreConfirmed: boolean,
): { content: string; restored: boolean; discardDraft: boolean } {
  if (recoveredContent === undefined || !recoveryNeedsConfirmation(diskContent, recoveredContent)) {
    return { content: diskContent, restored: false, discardDraft: recoveredContent !== undefined }
  }
  if (restoreConfirmed) {
    return { content: recoveredContent, restored: true, discardDraft: false }
  }
  return { content: diskContent, restored: false, discardDraft: true }
}
