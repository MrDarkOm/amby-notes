import * as React from "react"

/** A part of the interface that has no access to the tabs opens a note with this event. */
export const OPEN_NOTE_REQUEST_EVENT = "amby:open-note-request"

/** The note by its id in the workspace, or by its path in the vault (the journal knows only that). */
export type OpenNoteRequest = { id: string; path?: undefined } | { path: string; id?: undefined }

/** Asks the workspace to open a note (and to show its tab if it is open already). */
export function requestOpenNote(request: OpenNoteRequest): void {
  window.dispatchEvent(
    new CustomEvent<OpenNoteRequest>(OPEN_NOTE_REQUEST_EVENT, { detail: request }),
  )
}

/** The workspace answers the requests of `requestOpenNote`. */
export function useOpenNoteRequests(open: (request: OpenNoteRequest) => void): void {
  const latest = React.useRef(open)
  latest.current = open
  React.useEffect(() => {
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<OpenNoteRequest | undefined>).detail
      if (detail) latest.current(detail)
    }
    window.addEventListener(OPEN_NOTE_REQUEST_EVENT, onRequest)
    return () => window.removeEventListener(OPEN_NOTE_REQUEST_EVENT, onRequest)
  }, [])
}
