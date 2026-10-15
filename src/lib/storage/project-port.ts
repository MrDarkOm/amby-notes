import type { Result } from "@/lib/bindings"
import {
  projectErrorMessage,
  ProjectOperationError,
  type AddStoryLinksRequest,
  type AddTextStatusRequest,
  type AddedStoryLinks,
  type AddedTextStatus,
  type CreateStoryRequest,
  type CreateWorkshopEntityRequest,
  type CompleteWorkshopRequest,
  type CompletedWorkshop,
  type CreateWorkshopSectionRequest,
  type CreatedStory,
  type CreatedWorkshop,
  type CreatedWorkshopEntity,
  type CreatedWorkshopSectionResult,
  type CreatedTextPage,
  type CreateTextPageRequest,
  type EnsurePlotLinksRequest,
  type EnsuredPlotLinks,
  type InitWorkshopRequest,
  type MoveTextPageRequest,
  type MovedTextPage,
  type NoteReference,
  type NotebookCatalog,
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
  /**
   * Makes the workshop of the vault at the folder `request.path`: the folder, its marker and all
   * seven bases with every link, as one journaled operation. The folder must be absent or empty.
   */
  initWorkshop(request: InitWorkshopRequest): Promise<CreatedWorkshop>
  /**
   * Adds what a workshop made before is missing (bases and links); what is there is not touched,
   * and repeating it writes nothing.
   */
  completeWorkshop(request: CompleteWorkshopRequest): Promise<CompletedWorkshop>
  /**
   * The vault-relative form of an absolute folder path picked in a dialog, checked in Rust: the
   * folder must exist, lie inside the open vault and be usable as a workshop folder.
   */
  resolveWorkshopFolder(pickedPath: string): Promise<string>
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
  /**
   * Links a section of an older workshop: a world section to stories, or the stories section to
   * universes. Adopts a relation the section already has, else adds one.
   */
  addStoryLinks(request: AddStoryLinksRequest): Promise<AddedStoryLinks>
  /**
   * Makes the "Anchors" and "Arcs" relations of a story's text (target `story`), or the "Arcs" and
   * "Universe" relations of the anchors (target `anchors`), wherever the databases they point at
   * exist. What already exists is recorded, not made again; when nothing is missing nothing is
   * written (`changed: false`).
   */
  ensurePlotLinks(request: EnsurePlotLinksRequest): Promise<EnsuredPlotLinks>
  /**
   * A page of a world section, born linked to a story's card when `storyId` is given and, for
   * the notes base, into the notebook (a folder of the base) named by `notebook`.
   */
  createWorkshopEntity(request: CreateWorkshopEntityRequest): Promise<CreatedWorkshopEntity>
  /** A page of a story's text with its level, format, parent and place, in one write. */
  createTextPage(request: CreateTextPageRequest): Promise<CreatedTextPage>
  /** Moves a page: parent and order in one write, refused when it would make a loop. */
  moveTextPage(request: MoveTextPageRequest): Promise<MovedTextPage>
  /** The relations of one note, both ways: the dossier's "Appears in" and "Connections". */
  listNoteReferences(noteId: string): Promise<NoteReference[]>
  /** Words and last-change time of every page of one database, from the note index. */
  listTextStats(databaseId: string): Promise<TextPageStat[]>
  /** The notebooks (folders) of one base, read from the disk; empty ones are listed too. */
  listNotebooks(databaseId: string): Promise<NotebookCatalog>
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
