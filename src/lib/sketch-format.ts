// ── Excalidraw file format schema and serialization helpers ──────────────────
// Conforms to Excalidraw v2 schema.

export interface ExcalidrawFile {
  type: "excalidraw"
  version: number
  source: string
  elements: readonly Record<string, unknown>[]
  appState: Record<string, unknown>
  files: Record<string, unknown>
  [key: string]: unknown
}

export function createDefaultSketch(): ExcalidrawFile {
  return {
    type: "excalidraw",
    version: 2,
    source: "amby-notes",
    elements: [],
    appState: {
      viewBackgroundColor: "#ffffff",
      gridSize: null,
    },
    files: {},
  }
}

const RUNTIME_APP_STATE_KEYS = new Set([
  "collaborators",
  "followedBy",
  "selectedElementIds",
  "hoveredElementIds",
  "selectedGroupIds",
  "selectedLinearElement",
  "selectionElement",
  "selectedElementsAreBeingDragged",
  "previousSelectedElementIds",
  "editingTextElement",
  "editingLinearElement",
  "editingGroupId",
  "editingFrame",
  "activeTool",
  "activeEmbeddable",
  "cursorButton",
  "resizingElement",
  "elementsToHighlight",
  "frameToHighlight",
  "snapLines",
  "originSnapOffset",
  "userToFollow",
  "toast",
  "contextMenu",
  "openMenu",
  "openPopup",
  "openSidebar",
  "openDialog",
  "pasteDialog",
  "searchMatches",
  "width",
  "height",
  "offsetLeft",
  "offsetTop",
  "scrollX",
  "scrollY",
  "scrolledOutside",
  "zoom",
  "isLoading",
  "isResizing",
  "isRotating",
  "isCropping",
  "croppingElementId",
  "lastPointerDownWith",
  "multiElement",
  "suggestedBindings",
  "startBoundElement",
  "pendingImageElementId",
  "showHyperlinkPopup",
  "stats",
  "errorMessage",
  "fileHandle",
  "theme",
  "viewModeEnabled",
  "zenModeEnabled",
  "gridModeEnabled",
  "objectsSnapModeEnabled",
  "defaultSidebarDockedPreference",
  "penMode",
  "penDetected",
  "invertMode",
  "autoPan",
  "autoPanSpeed",
])

/**
 * Sanitizes appState by removing runtime-only and non-serializable fields.
 * Preserves document-level presentation options (viewBackgroundColor, gridSize, gridStep, etc.).
 */
function sanitizeAppState(
  appState: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    viewBackgroundColor: "#ffffff",
    gridSize: null,
  }
  if (!appState || typeof appState !== "object" || Array.isArray(appState)) {
    return result
  }
  for (const [key, value] of Object.entries(appState)) {
    if (RUNTIME_APP_STATE_KEYS.has(key)) {
      continue
    }
    if (key.startsWith("currentItem") || key.startsWith("previous")) {
      continue
    }
    if (typeof value === "function" || typeof value === "symbol") {
      continue
    }
    // Prevent non-serializable Map/Set instances from polluting the plain object
    if (value instanceof Map || value instanceof Set) {
      continue
    }
    result[key] = value
  }
  return result
}

/**
 * Tolerant parser for Excalidraw JSON.
 * Returns a valid Excalidraw document even if the input is empty or malformed.
 */
export function parseSketch(json: string | null | undefined): ExcalidrawFile {
  if (!json || !json.trim()) return createDefaultSketch()
  try {
    const data = JSON.parse(json) as Partial<ExcalidrawFile> & Record<string, unknown>
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return createDefaultSketch()
    }
    const elements = Array.isArray(data.elements) ? data.elements : []
    const appState = sanitizeAppState(
      data.appState && typeof data.appState === "object" && !Array.isArray(data.appState)
        ? (data.appState as Record<string, unknown>)
        : null,
    )
    const files =
      data.files && typeof data.files === "object" && !Array.isArray(data.files)
        ? (data.files as Record<string, unknown>)
        : {}

    const {
      elements: _e,
      appState: _a,
      files: _f,
      type = "excalidraw",
      version = 2,
      source = "amby-notes",
      ...unknownFields
    } = data

    return {
      type: (type as "excalidraw") || "excalidraw",
      version: typeof version === "number" ? version : 2,
      source: typeof source === "string" ? source : "amby-notes",
      elements,
      appState,
      files,
      ...unknownFields,
    }
  } catch {
    return createDefaultSketch()
  }
}

/**
 * Strict validator and serializer for disk persistence.
 * Rejects corrupt input so bad editor output never replaces a valid on-disk sketch.
 * Carries unknown top-level fields through untouched for format preservation.
 */
export function validateAndSerializeSketch(json: string): string {
  let data: unknown
  try {
    // A byte order mark is not JSON. The file write puts the BOM back from the file on disk.
    data = JSON.parse(json.replace(/^\uFEFF/u, ""))
  } catch {
    throw new Error("Sketch content must be valid JSON")
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Sketch content must be a JSON object")
  }
  const file = data as Partial<ExcalidrawFile> & Record<string, unknown>

  // Elements, appState, files must be structurally sound if present
  if (file.elements !== undefined && !Array.isArray(file.elements)) {
    throw new Error("Sketch elements must be an array")
  }
  if (
    file.appState !== undefined &&
    (typeof file.appState !== "object" || Array.isArray(file.appState) || file.appState === null)
  ) {
    throw new Error("Sketch appState must be an object")
  }
  if (
    file.files !== undefined &&
    (typeof file.files !== "object" || Array.isArray(file.files) || file.files === null)
  ) {
    throw new Error("Sketch files must be an object")
  }

  const elements = file.elements ?? []
  const appState = sanitizeAppState(file.appState as Record<string, unknown> | undefined)
  const files = file.files ?? {}
  const type = file.type || "excalidraw"
  const version = typeof file.version === "number" ? file.version : 2
  const source = typeof file.source === "string" ? file.source : "amby-notes"

  const {
    elements: _e,
    appState: _a,
    files: _f,
    type: _t,
    version: _v,
    source: _s,
    ...unknownFields
  } = file

  const canonical: ExcalidrawFile = {
    type: type as "excalidraw",
    version,
    source,
    elements,
    appState,
    files,
    ...unknownFields,
  }

  return JSON.stringify(canonical, null, 2) + "\n"
}

/**
 * Serializes Excalidraw state into a canonical JSON string.
 */
export function serializeSketch(data: {
  elements?: readonly Record<string, unknown>[]
  appState?: Record<string, unknown>
  files?: Record<string, unknown>
  [key: string]: unknown
}): string {
  const elements = data.elements ?? []
  const appState = sanitizeAppState(data.appState)
  const files = data.files ?? {}
  const {
    elements: _e,
    appState: _a,
    files: _f,
    type = "excalidraw",
    version = 2,
    source = "amby-notes",
    ...unknown
  } = data

  const canonical: ExcalidrawFile = {
    type: (type as "excalidraw") || "excalidraw",
    version: typeof version === "number" ? version : 2,
    source: typeof source === "string" ? source : "amby-notes",
    elements,
    appState,
    files,
    ...unknown,
  }

  return JSON.stringify(canonical, null, 2) + "\n"
}

/**
 * What the file had besides the live scene: top-level fields the editor does not own (including
 * the original `type`, `version` and `source`) and the stored canvas background. The editor keeps
 * one per open file so the first edit does not drop another program's fields.
 */
export interface SketchTemplate {
  /** Top-level fields other than `elements`, `appState` and `files`, in file order. */
  extras: Record<string, unknown>
  /** True while the editor shows the default white background as `transparent`. */
  backgroundShownAsTransparent: boolean
  /** The background stored in the file; written back while it is shown as `transparent`. */
  storedBackground: unknown
}

/** The editor shows the default white background as transparent so the theme background shows. */
const SKETCH_DISPLAY_TRANSPARENT = "transparent"

export function sketchTemplateOf(
  sketch: ExcalidrawFile,
  defaultBackground: string = "#ffffff",
): SketchTemplate {
  const { elements: _e, appState: _a, files: _f, ...extras } = sketch
  const stored = sketch.appState.viewBackgroundColor
  return {
    extras,
    storedBackground: stored,
    backgroundShownAsTransparent: !stored || stored === defaultBackground,
  }
}

/** The background the editor should display for the stored one. */
export function displayBackground(stored: unknown, defaultBackground: string = "#ffffff"): unknown {
  return stored && stored !== defaultBackground ? stored : SKETCH_DISPLAY_TRANSPARENT
}

/**
 * Serializes the editor state on top of the file's own fields. Amby's fields (`elements`,
 * `appState`, `files`) take the current values; everything else, including `source`, stays as it
 * was in the file. A background the editor only displays as transparent is written back unchanged.
 */
export function serializeSketchWithTemplate(
  data: {
    elements?: readonly Record<string, unknown>[]
    appState?: Record<string, unknown>
    files?: Record<string, unknown>
  },
  template: SketchTemplate,
): string {
  let appState = data.appState
  const current = appState?.viewBackgroundColor
  if (template.backgroundShownAsTransparent) {
    if (current === SKETCH_DISPLAY_TRANSPARENT) {
      appState = { ...appState, viewBackgroundColor: template.storedBackground }
    } else if (current !== undefined) {
      // The person chose a colour: from now on the value is theirs, not the display stand-in.
      template.backgroundShownAsTransparent = false
    }
  }
  return serializeSketch({ ...template.extras, ...data, appState })
}

/**
 * Returns canonical serialized JSON for a new default sketch.
 */
export function defaultSketchJson(): string {
  return serializeSketch(createDefaultSketch())
}
