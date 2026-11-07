// Test helper: the dock with the notices button, drawn by the real `ActivityBar`, as the workspace wears it.
import { ActivityBar } from "../activity-bar"
import { findButtonDef } from "../panel-definitions"
import type { ActionContext } from "../panel-registry"

/** The left dock with only the notices button; a click runs the action of the button as the workspace does. */
export function NoticesDock() {
  return (
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
  )
}

/** The notices button of the dock. */
export const dockButton = () =>
  document.querySelector<HTMLButtonElement>('[data-activity-button="notices"]')
