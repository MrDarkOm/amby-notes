import { SyncNoticesHost } from "./sync/sync-notices-host"
import { WorkspaceOrchestration } from "./workspace-orchestration"

/**
 * Stable public entry point; workspace behavior is composed in the orchestration root. The host of
 * the sync notices sits beside it, so it is there in every layout (docs/sync-plan.md, З67).
 */
export function Workspace() {
  return (
    <>
      <WorkspaceOrchestration />
      <SyncNoticesHost />
    </>
  )
}
