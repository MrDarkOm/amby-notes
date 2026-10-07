// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { stopsEditorEvent } from "./amby-block-node"

function eventOn(target: Element, type: string): Event {
  const event = new Event(type, { bubbles: true })
  target.dispatchEvent(event)
  Object.defineProperty(event, "target", { value: target })
  return event
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("which events an amby block keeps from the editor", () => {
  it("keeps every event inside a database block, so a click does not select the block", () => {
    document.body.innerHTML = `<div class="amby-database-host"><div id="cell"></div></div>`
    const cell = document.getElementById("cell")!
    for (const type of ["mousedown", "click", "keydown", "dragstart", "paste"]) {
      expect(stopsEditorEvent(eventOn(cell, type))).toBe(true)
    }
  })

  it("leaves the legacy table's selection and clipboard to the editor, but not its inputs", () => {
    document.body.innerHTML = `<div class="amby-db-block"><div id="box"></div><input id="field" /></div>`
    const box = document.getElementById("box")!
    expect(stopsEditorEvent(eventOn(box, "mousedown"))).toBe(false)
    expect(stopsEditorEvent(eventOn(box, "paste"))).toBe(false)
    expect(stopsEditorEvent(eventOn(box, "keydown"))).toBe(true)
    expect(stopsEditorEvent(eventOn(document.getElementById("field")!, "mousedown"))).toBe(true)
  })
})
