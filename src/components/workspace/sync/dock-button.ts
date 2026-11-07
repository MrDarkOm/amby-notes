/** Test helper: the notices button of the dock, drawn by the real `ActivityBar`. */
export const dockButton = () =>
  document.querySelector<HTMLButtonElement>('[data-activity-button="notices"]')
