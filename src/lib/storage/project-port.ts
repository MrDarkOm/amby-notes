import type { Result } from "@/lib/bindings"
import {
  projectErrorMessage,
  ProjectOperationError,
  type AddTextStatusRequest,
  type AddedTextStatus,
  type CreateProjectRequest,
  type CreateProjectSectionRequest,
  type CreatedProject,
  type CreatedSection,
  type CreatedTextPage,
  type CreateTextPageRequest,
  type MoveTextPageRequest,
  type MovedTextPage,
  type NoteReference,
  type ProjectCatalog,
  type ProjectError,
  type RemoveProjectSectionRequest,
  type RemovedProjectSection,
  type ReorderProjectSectionsRequest,
  type ReorderedProjectSections,
  type TextPageStat,
  type UpdateProjectRequest,
  type UpdateTextLevelsRequest,
  type UpdatedProject,
  type UpdatedTextLevels,
} from "./project-types"

/**
 * Creative projects (`amby-project.json`). Discovery, creation and recovery are
 * done in Rust; the renderer only asks. Every write names an `operationId` per
 * user intent, so repeating a call never creates a second set.
 */
export interface ProjectPort {
  /** The projects and sections of the vault, read from the rebuildable index. */
  listProjects(): Promise<ProjectCatalog>
  /** Rebuild the index from the files (after a `project:changed` event), then list. */
  refreshProjects(expectedGeneration: number): Promise<ProjectCatalog>
  createProject(request: CreateProjectRequest): Promise<CreatedProject>
  createProjectSection(request: CreateProjectSectionRequest): Promise<CreatedSection>
  /** Updates a project's display name, icon, or tags in `amby-project.json`. */
  updateProject(request: UpdateProjectRequest): Promise<UpdatedProject>
  /** Unlinks a section from `amby-project.json` without deleting its database on disk. */
  removeProjectSection(request: RemoveProjectSectionRequest): Promise<RemovedProjectSection>
  /** Reorders `sections` in `amby-project.json`. */
  reorderProjectSections(request: ReorderProjectSectionsRequest): Promise<ReorderedProjectSections>
  /** Renames, re-icons, reorders or adds levels of a story's text schema. */
  updateTextLevels(request: UpdateTextLevelsRequest): Promise<UpdatedTextLevels>
  /** Adds the optional `status` property to an existing story's text database. */
  addTextStatus(request: AddTextStatusRequest): Promise<AddedTextStatus>
  /** A page of a story's text with its level, format, parent and place, in one write. */
  createTextPage(request: CreateTextPageRequest): Promise<CreatedTextPage>
  /** Moves a page: parent and order in one write, refused when it would make a loop. */
  moveTextPage(request: MoveTextPageRequest): Promise<MovedTextPage>
  /** The relations of one note, both ways: the dossier's "Appears in" and "Connections". */
  listNoteReferences(noteId: string): Promise<NoteReference[]>
  /** Words and last-change time of every page of one database, from the note index. */
  listTextStats(databaseId: string): Promise<TextPageStat[]>
}

/** Convert typed domain errors while keeping transport failures untouched. */
export function unwrapProjectCommand<T>(result: Result<T, ProjectError>): T {
  if (result.status === "ok") return result.data
  throw new ProjectOperationError(
    result.error.kind,
    projectErrorMessage(result.error),
    result.error,
  )
}
