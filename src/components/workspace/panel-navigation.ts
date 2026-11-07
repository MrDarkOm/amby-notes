import * as React from "react"

import type { PanelId } from "./panel-registry"

/** A part of the interface that has no access to the layout opens a dock panel with this event. */
export const OPEN_PANEL_REQUEST_EVENT = "amby:open-panel-request"

export interface OpenPanelRequest {
  panelId: PanelId
}

/** Asks the workspace to open a panel of the dock (it does nothing when the module of the panel is off). */
export function requestOpenPanel(panelId: PanelId): void {
  window.dispatchEvent(
    new CustomEvent<OpenPanelRequest>(OPEN_PANEL_REQUEST_EVENT, { detail: { panelId } }),
  )
}

/** The workspace answers the requests of `requestOpenPanel`. */
export function useOpenPanelRequests(activate: (panelId: PanelId) => void): void {
  // The layout hook makes a new function on every render: the latest one is read when a request comes.
  const latest = React.useRef(activate)
  latest.current = activate
  React.useEffect(() => {
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<OpenPanelRequest | undefined>).detail
      if (detail) latest.current(detail.panelId)
    }
    window.addEventListener(OPEN_PANEL_REQUEST_EVENT, onRequest)
    return () => window.removeEventListener(OPEN_PANEL_REQUEST_EVENT, onRequest)
  }, [])
}
