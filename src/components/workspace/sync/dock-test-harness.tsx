// Test helper: the dock with the notices button, drawn by the real `ActivityBar`, and the stack of the
// notification centre it opens, drawn by the real `NoticesStack`, as the workspace wears them.
import type { SyncPort } from "@/lib/sync/sync-port"
import { ActivityBar } from "../activity-bar"
import { findButtonDef } from "../panel-definitions"
import type { ActionContext } from "../panel-registry"
import { NoticesStack } from "../notices/notices-stack"

/** The left dock with only the notices button; a click runs the action of the button as the workspace does. */
export function NoticesDock({ port }: { port?: SyncPort }) {
  return (
    <>
      <ActivityBar
        side="left"
        buttons={[{ defId: "notices", side: "left", order: 0 }]}
        activeView={null}
        isPanelOpen={false}
        onActivate={(defId) => {
          const def = findButtonDef(defId)
          if (def?.kind === "action") def.invoke?.({} as ActionContext)
        }}
        onPointerDownButton={() => () => {}}
        draggingId={null}
        onOpenSettings={() => {}}
      />
      <NoticesStack port={port} />
    </>
  )
}
