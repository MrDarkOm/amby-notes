// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

// The orchestration root is heavy and has two layouts; here only what the entry point mounts matters.
vi.mock("./workspace-orchestration", () => ({
  WorkspaceOrchestration: () => <div data-testid="orchestration" />,
}))
vi.mock("./sync/sync-notices-host", () => ({
  SyncNoticesHost: () => <div data-testid="sync-notices-host" />,
}))

import { Workspace } from "./workspace"

describe("Workspace", () => {
  // docs/sync-plan.md З67: the host of the sync notices lived in a shell nothing rendered, so the
  // events of synchronisation (sync-amby-written, sync-remote-deleted, the restored notes, the
  // conflict notice, the limits) never reached the application.
  it("mounts the host of the sync notices once, beside the orchestration", () => {
    render(<Workspace />)
    expect(screen.getByTestId("orchestration")).toBeTruthy()
    expect(screen.getAllByTestId("sync-notices-host")).toHaveLength(1)
  })
})
