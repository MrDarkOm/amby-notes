import { findButtonDef } from "./panel-definitions"
import type { ActivityButton } from "./panel-registry"

/**
 * The buttons as shown while the right panel is off: every right-side button joins the left
 * dock, after the ones already there, in its own order. Views and actions are ordered apart, as
 * they are on each side. This is a view of the stored buttons: nothing is rewritten, so turning
 * the right panel back on returns each button to its own side.
 */
export function collapseButtonsToLeft(buttons: ActivityButton[]): ActivityButton[] {
  if (!buttons.some((button) => button.side === "right")) return buttons
  const kindOf = (button: ActivityButton) => findButtonDef(button.defId)?.kind ?? "view"
  const result: ActivityButton[] = []
  for (const kind of ["view", "action"] as const) {
    const ofKind = buttons.filter((button) => kindOf(button) === kind)
    const bySide = (side: "left" | "right") =>
      ofKind.filter((button) => button.side === side).sort((a, b) => a.order - b.order)
    ;[...bySide("left"), ...bySide("right")].forEach((button, order) => {
      result.push({ ...button, side: "left", order })
    })
  }
  return result
}
