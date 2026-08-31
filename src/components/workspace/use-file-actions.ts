import {
  useDocumentCrud,
  useDocumentLoading,
  useDocumentMutations,
  useMarkdownAutosave,
  useWikiNavigation,
  type UseFileActionsParams,
} from "./file-actions"
import { useSessionDocumentLoading } from "./use-session-document-loading"

/**
 * Compatibility façade for workspace file actions. The stateful behaviour is
 * owned by focused hooks so each concern retains a single source of truth.
 */
export function useFileActions(params: UseFileActionsParams) {
  const markdownAutosave = useMarkdownAutosave(params)
  const loading = useDocumentLoading({ ...params, ...markdownAutosave })
  useSessionDocumentLoading(loading.loadDoc)
  const wikiNavigation = useWikiNavigation({
    ...params,
    ...markdownAutosave,
    handleSelect: loading.handleSelect,
  })
  const mutations = useDocumentMutations({
    ...params,
    ...markdownAutosave,
    handleSelect: loading.handleSelect,
  })
  const crud = useDocumentCrud({ ...params, ...markdownAutosave, loadDoc: loading.loadDoc })

  return {
    ...loading,
    ...wikiNavigation,
    ...crud,
    ...mutations,
    handleContentChange: markdownAutosave.handleContentChange,
    releaseUnusedDocumentBuffers: markdownAutosave.releaseUnusedDocumentBuffers,
  }
}
