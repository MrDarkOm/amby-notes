// @vitest-environment happy-dom
import * as React from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { Popover, PopoverContent, PopoverTrigger } from "./popover"

function Two() {
  const [a, setA] = React.useState(false)
  const [b, setB] = React.useState(false)
  return (
    <div>
      <Popover open={a} onOpenChange={setA}>
        <PopoverTrigger>open a</PopoverTrigger>
        <PopoverContent>content a</PopoverContent>
      </Popover>
      <Popover open={b} onOpenChange={setB}>
        <PopoverTrigger>open b</PopoverTrigger>
        <PopoverContent>
          content b
          <Popover>
            <PopoverTrigger>open inner</PopoverTrigger>
            <PopoverContent>inner content</PopoverContent>
          </Popover>
        </PopoverContent>
      </Popover>
      <p>outside</p>
    </div>
  )
}

const press = (element: Element) => act(() => void fireEvent.pointerDown(element))

describe("popovers", () => {
  afterEach(cleanup)

  it("close when something outside is pressed, even if that press is stopped", () => {
    render(<Two />)
    fireEvent.click(screen.getByText("open a"))
    expect(screen.getByText("content a")).toBeTruthy()
    const outside = screen.getByText("outside")
    outside.addEventListener("pointerdown", (event) => event.stopPropagation())
    press(outside)
    expect(screen.queryByText("content a")).toBeNull()
  })

  it("keep only one open: opening another closes the first", () => {
    render(<Two />)
    fireEvent.click(screen.getByText("open a"))
    fireEvent.click(screen.getByText("open b"))
    expect(screen.queryByText("content a")).toBeNull()
    expect(screen.getByText("content b")).toBeTruthy()
  })

  it("leave a popover open while one inside it is used", () => {
    render(<Two />)
    fireEvent.click(screen.getByText("open b"))
    fireEvent.click(screen.getByText("open inner"))
    expect(screen.getByText("inner content")).toBeTruthy()
    press(screen.getByText("inner content"))
    expect(screen.getByText("content b")).toBeTruthy()
    expect(screen.getByText("inner content")).toBeTruthy()
  })
})
