export { DocumentEditor, type Document, type DocumentEditorProps } from "./document-editor"
export { DocumentHeader, type DocumentHeaderProps } from "./document-header"
export { handleDragStart } from "./document-header-utils"
export { DocumentTitle, type DocumentTitleProps } from "./document-title"
export { DocumentBreadcrumbs, type DocumentBreadcrumbsProps } from "./document-breadcrumbs"
export {
  type BreadcrumbSegment,
  buildBreadcrumb,
  findBreadcrumbTrail,
  flattenTree,
  relativeToVault,
  stripMdExt,
} from "./document-breadcrumbs-utils"
export {
  DocumentActionsDropdown,
  LayerButton,
  LayerConfirmDialog,
  FilePickerModal,
  type LayerKind,
} from "./document-actions"
export { DocumentBody, type DocumentBodyProps } from "./document-body"
export { LAYER_OPTIONS, type DocumentViewMode, type EditorLayer } from "./use-document-view-mode"
