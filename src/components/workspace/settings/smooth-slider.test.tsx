// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { SmoothSlider } from "./smooth-slider"

afterEach(cleanup)

const setup = (value = 100) => {
  const onChange = vi.fn()
  const onPreview = vi.fn()
  render(
    <SmoothSlider
      value={value}
      format={(v) => `${v}%`}
      min={80}
      max={130}
      snap={100}
      ariaLabel="Размер шрифта"
      onChange={onChange}
      onPreview={onPreview}
    />,
  )
  const slider = screen.getByRole("slider", { name: "Размер шрифта" })
  // The track spans 0..500 px, so every 10 px is one percent.
  const track = slider.firstElementChild as HTMLElement
  track.getBoundingClientRect = () =>
    ({ left: 0, width: 500, top: 0, height: 24, right: 500, bottom: 24 }) as DOMRect
  slider.setPointerCapture = () => {}
  slider.hasPointerCapture = () => true
  slider.releasePointerCapture = () => {}
  return { slider, onChange, onPreview }
}

describe("the smooth slider", () => {
  it("shows its value as a percentage", () => {
    const { slider } = setup(113)
    expect(slider.getAttribute("aria-valuenow")).toBe("113")
    expect(slider.getAttribute("aria-valuetext")).toBe("113%")
    expect(screen.getByText("113%")).toBeTruthy()
  })

  it("previews every move while dragging and keeps the value once let go", () => {
    const { slider, onChange, onPreview } = setup()
    fireEvent.pointerDown(slider, { clientX: 300, pointerId: 1 })
    fireEvent.pointerMove(slider, { clientX: 420, pointerId: 1 })
    expect(onPreview).toHaveBeenLastCalledWith(122)
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText("122%")).toBeTruthy()
    fireEvent.pointerUp(slider, { clientX: 420, pointerId: 1 })
    expect(onChange).toHaveBeenCalledWith(122)
  })

  it("settles on the default when let go close to it", () => {
    const { slider, onChange } = setup(90)
    fireEvent.pointerDown(slider, { clientX: 210, pointerId: 1 })
    fireEvent.pointerUp(slider, { clientX: 210, pointerId: 1 })
    expect(onChange).toHaveBeenCalledWith(100)
  })

  it("moves by one with the arrows, by ten with Shift, and stops at the ends", () => {
    const { slider, onChange } = setup(125)
    fireEvent.keyDown(slider, { key: "ArrowRight" })
    expect(onChange).toHaveBeenLastCalledWith(126)
    fireEvent.keyDown(slider, { key: "ArrowRight", shiftKey: true })
    expect(onChange).toHaveBeenLastCalledWith(130)
    fireEvent.keyDown(slider, { key: "Home" })
    expect(onChange).toHaveBeenLastCalledWith(80)
  })

  it("keeps values on its step", () => {
    const onChange = vi.fn()
    render(
      <SmoothSlider
        value={1000}
        min={0}
        max={2100}
        step={100}
        bigStep={500}
        format={(v) => `${v} ms`}
        ariaLabel="Задержка"
        onChange={onChange}
      />,
    )
    const slider = screen.getByRole("slider", { name: "Задержка" })
    const track = slider.firstElementChild as HTMLElement
    track.getBoundingClientRect = () =>
      ({ left: 0, width: 210, top: 0, height: 24, right: 210, bottom: 24 }) as DOMRect
    slider.setPointerCapture = () => {}
    slider.hasPointerCapture = () => true
    slider.releasePointerCapture = () => {}
    fireEvent.pointerDown(slider, { clientX: 33, pointerId: 1 })
    fireEvent.pointerUp(slider, { clientX: 33, pointerId: 1 })
    expect(onChange).toHaveBeenLastCalledWith(300)
    fireEvent.keyDown(slider, { key: "ArrowLeft", shiftKey: true })
    expect(onChange).toHaveBeenLastCalledWith(500)
    expect(slider.getAttribute("aria-valuetext")).toBe("1000 ms")
  })
})
