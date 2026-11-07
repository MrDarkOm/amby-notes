// Test helper: the dock with the notices button, drawn by the real `ActivityBar`, and the panel it opens,
// drawn by the real `PanelHost`, as the workspace wears them.
import * as React from "react"

import { ActivityBar } from "../activity-bar"
import { findButtonDef } from "../panel-definitions"
import { PanelHost } from "../panel-host"
import type { ActionContext, PanelRenderProps } from "../panel-registry"

/** The id of the panel of the notification centre. */
export const CENTRE_PANEL_ID = "notices-centre"

/**
 * The left dock with only the notices button. A click does what the workspace does: an action that
 * opens a panel toggles it, any other action runs.
 */
export function NoticesDock() {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <ActivityBar
        side="left"
        buttons={[{ defId: "notices", side: "left", order: 0 }]}
        activeView={open ? CENTRE_PANEL_ID : null}
        isPanelOpen={open}
        onActivate={(defId) => {
          const def = findButtonDef(defId)
          if (def?.kind !== "action") return
          if (def.opens) setOpen((value) => !value)
          else def.invoke?.({} as ActionContext)
        }}
        onPointerDownButton={() => () => {}}
        draggingId={null}
        onOpenSettings={() => {}}
      />
      {open && <PanelHost side="left" activeId={CENTRE_PANEL_ID} props={{} as PanelRenderProps} />}
    </>
  )
}
