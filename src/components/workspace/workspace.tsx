import { NoticesHost } from "./notices/notices-host"
import { SyncNoticesHost } from "./sync/sync-notices-host"
import { WorkspaceOrchestration } from "./workspace-orchestration"

/**
 * Stable public entry point; workspace behavior is composed in the orchestration root. The host of
 * the sync notices and the host of the notification centre sit beside it, so they are there in every layout
 * (docs/sync-plan.md, З67; docs/notices.md, section 5).
 */
export function Workspace() {
  return (
    <>
      <WorkspaceOrchestration />
      <SyncNoticesHost />
      <NoticesHost />
    </>
  )
}
