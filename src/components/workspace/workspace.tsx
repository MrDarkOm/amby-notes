import { WorkspaceOrchestration } from "./workspace-orchestration"

/** Stable public entry point; workspace behavior is composed in the orchestration root. */
export function Workspace() {
  return <WorkspaceOrchestration />
}
