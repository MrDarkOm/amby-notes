import { useAppNoticesStore } from "../notices/use-app-notices-store"

/**
 * A picture could not be read, copied or saved. The note is not changed and nobody waits for an answer, so
 * it is a warning in the notification centre (docs/notices.md, sections 2.1 and 3), in words.
 */
export function reportImageFailure(): void {
  useAppNoticesStore.getState().post({
    id: "image-failed",
    level: "warning",
    titleKey: "editorToolbar.imageFailed",
    lineKey: "notices.app.nothingChanged",
  })
}
