import type { Result } from "@/lib/bindings"
import {
  projectErrorMessage,
  ProjectOperationError,
  type AddTextStatusRequest,
  type AddedTextStatus,
  type CreateStoryRequest,
  type CreateWorkshopRequest,
  type CreateWorkshopSectionRequest,
  type CreatedStory,
  type CreatedWorkshop,
  type CreatedWorkshopSectionResult,
  type CreatedTextPage,
  type CreateTextPageRequest,
  type MoveTextPageRequest,
  type MovedTextPage,
  type NoteReference,
  type ProjectCatalog,
  type ProjectError,
  type RemoveWorkshopSectionRequest,
  type RemovedWorkshopSection,
  type ReorderWorkshopSectionsRequest,
  type ReorderedWorkshopSections,
  type TextPageStat,
  type UpdateTextLevelsRequest,
  type UpdateWorkshopRequest,
  type UpdatedTextLevels,
  type UpdatedWorkshop,
} from "./project-types"

/**
 * Creative workshops (`amby-workshop.json`). Discovery, creation and recovery are
 * done in Rust; the renderer only asks. Every write names an `operationId` per
 * user intent, so repeating a call never creates a second set.
 */
export interface ProjectPort {
  /** The workshops and sections of the vault, read from the rebuildable index. */
  listProjects(): Promise<ProjectCatalog>
  /** Rebuild the index from the files (after a `project:changed` event), then list. */
  refreshProjects(expectedGeneration: number): Promise<ProjectCatalog>
  createWorkshop(request: CreateWorkshopRequest): Promise<CreatedWorkshop>
  createStory(request: CreateStoryRequest): Promise<CreatedStory>
  createWorkshopSection(
    request: CreateWorkshopSectionRequest,
  ): Promise<CreatedWorkshopSectionResult>
  /** Updates a workshop's display name, icon, or tags in `amby-workshop.json`. */
  updateWorkshop(request: UpdateWorkshopRequest): Promise<UpdatedWorkshop>
  /** Unlinks a section from `amby-workshop.json` without deleting its database on disk. */
  removeWorkshopSection(request: RemoveWorkshopSectionRequest): Promise<RemovedWorkshopSection>
  /** Reorders `sections` in `amby-workshop.json`. */
  reorderWorkshopSections(
    request: ReorderWorkshopSectionsRequest,
  ): Promise<ReorderedWorkshopSections>
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
