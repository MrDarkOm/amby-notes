import type { ProjectError } from "@/lib/bindings"

// The contract lives in Rust (`src-tauri/src/project/model.rs`); the types are
// the generated ones so the two sides cannot drift apart.
export type {
  CreateProjectRequest,
  CreateProjectSectionRequest,
  CreatedProject,
  CreatedProjectSection,
  CreatedSection,
  CreatedTextPage,
  CreateTextPageRequest,
  MoveTextPageRequest,
  MovedTextPage,
  NoteReference,
  ReferenceDirection,
  ProjectCatalog,
  ProjectDiagnostic,
  ProjectError,
  ProjectGroupSummary,
  ProjectKind,
  ProjectSectionSummary,
  ProjectSummary,
  ProjectTextSummary,
  SectionState,
  TextEntryState,
  TextFormatSummary,
  TextLevelSummary,
  TextPageStat,
  TextPropertyIds,
} from "@/lib/bindings"

/** Payload of the `project:changed` event: a structure file or a whole folder moved. */
export interface ProjectChangedPayload {
  kind: "file" | "folder"
  /** Vault-relative, slash-normalized. */
  path: string
  generation: number
}

/** A typed project failure. `error` keeps the full payload (revisions, paths) for the caller. */
export class ProjectOperationError extends Error {
  constructor(
    public readonly kind: ProjectError["kind"],
    message: string,
    public readonly error?: ProjectError,
  ) {
    super(message)
    this.name = "ProjectOperationError"
  }
}

/** A developer-facing message; the interface localizes by `kind`. */
export function projectErrorMessage(error: ProjectError): string {
  switch (error.kind) {
    case "moduleDisabled":
      return "Database module is disabled"
    case "vaultNotOpen":
      return "No vault is open"
    case "vaultGenerationConflict":
      return `Vault changed before project operation (generation ${error.actualGeneration})`
    case "invalidOperationId":
      return "Invalid operation ID"
    case "operationIdReused":
      return `Operation ID ${error.operationId} was used for another request`
    case "invalidName":
      return `Invalid ${error.field}: ${error.reason}`
    case "invalidParent":
      return `Invalid parent folder: ${error.reason}`
    case "pathCollision":
      return `Path already exists: ${error.path}`
    case "nestedCollectionUnsupported":
      return `A collection cannot be created inside the collection at ${error.ancestorPath}`
    case "parentProjectReadOnly":
      return `The project at ${error.path} has an unknown format`
    case "projectNotFound":
      return `Project ${error.projectId} was not found`
    case "projectReadOnly":
      return `Project format ${error.formatVersion} is read-only`
    case "revisionConflict":
      return "The project file changed since it was read"
    case "unknownGroup":
      return `Unknown project group ${error.groupId}`
    case "unsupportedRole":
      return `Unsupported section role ${error.role}`
    case "textNotConfigured":
      return "The story has no text schema"
    case "unknownTextLevel":
      return `Unknown text level ${error.levelId}`
    case "unknownTextFormat":
      return `Unknown text format ${error.formatId}`
    case "invalidOrderKey":
      return "Invalid order key"
    case "pageNotFound":
      return `Page ${error.noteId} was not found in the text`
    case "parentCycle":
      return "A page cannot go under its own descendant"
    case "parentLevelNotShallower":
      return "A parent must be on a shallower level than the page"
    case "unsupportedPreset":
      return `Unsupported section preset ${error.preset}`
    case "rolledBack":
      return `Operation rolled back: ${error.message}`
    case "recoveryRequired":
      return `Recovery required: ${error.message}`
    case "failed":
      return error.message
  }
}
