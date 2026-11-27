import { describe, expect, it } from "vitest"

import { dragCropRect, fitCropRatio, scaleCropRect, MIN_CROP_SIZE } from "./image-crop"

const bounds = { width: 400, height: 200 }
const frame = { x: 100, y: 50, width: 200, height: 100 }

describe("dragCropRect", () => {
  it("moves the frame but keeps it inside the picture", () => {
    expect(dragCropRect(frame, "move", 30, -20, bounds)).toEqual({
      x: 130,
      y: 30,
      width: 200,
      height: 100,
    })
    expect(dragCropRect(frame, "move", 999, 999, bounds)).toEqual({
      x: 200,
      y: 100,
      width: 200,
      height: 100,
    })
    expect(dragCropRect(frame, "move", -999, -999, bounds).x).toBe(0)
  })

  it("moves one edge, or two for a corner, and leaves the rest", () => {
    expect(dragCropRect(frame, "e", 40, 15, bounds)).toEqual({ ...frame, width: 240 })
    expect(dragCropRect(frame, "w", 40, 0, bounds)).toEqual({
      x: 140,
      y: 50,
      width: 160,
      height: 100,
    })
    expect(dragCropRect(frame, "nw", -20, -10, bounds)).toEqual({
      x: 80,
      y: 40,
      width: 220,
      height: 110,
    })
    expect(dragCropRect(frame, "se", 10, 10, bounds)).toEqual({ ...frame, width: 210, height: 110 })
  })

  it("never leaves the picture and never collapses the frame", () => {
    expect(dragCropRect(frame, "e", 999, 0, bounds).width).toBe(300)
    expect(dragCropRect(frame, "n", 0, -999, bounds)).toMatchObject({ y: 0, height: 150 })
    expect(dragCropRect(frame, "w", 999, 0, bounds)).toMatchObject({
      x: 300 - MIN_CROP_SIZE,
      width: MIN_CROP_SIZE,
    })
    expect(dragCropRect(frame, "s", 0, -999, bounds).height).toBe(MIN_CROP_SIZE)
  })
})

describe("scaleCropRect", () => {
  it("turns a frame on the shown picture into file pixels inside the file", () => {
    const file = { x: 0, y: 0, width: 800, height: 400 }
    expect(scaleCropRect(frame, 2, file)).toEqual({ x: 200, y: 100, width: 400, height: 200 })
    expect(scaleCropRect({ x: 390, y: 190, width: 50, height: 50 }, 2, file)).toEqual({
      x: 780,
      y: 380,
      width: 20,
      height: 20,
    })
  })
})

describe("a frame that keeps its ratio", () => {
  const ratio = 2
  const start = { x: 100, y: 50, width: 100, height: 50 }
  const keeps = (rect: { width: number; height: number }) =>
    expect(rect.width / rect.height).toBeCloseTo(ratio, 5)

  it("fits the largest frame of a ratio into the middle of the picture", () => {
    expect(fitCropRatio(bounds, 1)).toEqual({ x: 100, y: 0, width: 200, height: 200 })
    expect(fitCropRatio(bounds, 4)).toEqual({ x: 0, y: 50, width: 400, height: 100 })
  })

  it("keeps the ratio when a corner is pulled, and holds the opposite corner", () => {
    const grown = dragCropRect(start, "se", 40, 5, bounds, ratio)
    keeps(grown)
    expect(grown).toMatchObject({ x: 100, y: 50 })
    expect(grown.width).toBeGreaterThan(start.width)
    const upLeft = dragCropRect(start, "nw", -30, -10, bounds, ratio)
    keeps(upLeft)
    expect(upLeft.x + upLeft.width).toBeCloseTo(200)
    expect(upLeft.y + upLeft.height).toBeCloseTo(100)
  })

  it("keeps the ratio when an edge is pulled, growing from the middle of the other side", () => {
    const wider = dragCropRect(start, "e", 40, 0, bounds, ratio)
    keeps(wider)
    expect(wider.x).toBe(100)
    expect(wider.y + wider.height / 2).toBeCloseTo(75)
    const taller = dragCropRect(start, "s", 0, 20, bounds, ratio)
    keeps(taller)
    expect(taller.y).toBe(50)
    expect(taller.x + taller.width / 2).toBeCloseTo(150)
  })

  it("stays inside the picture and above the minimum size", () => {
    for (const handle of ["se", "nw", "e", "w", "n", "s"] as const) {
      const grown = dragCropRect(start, handle, 999, 999, bounds, ratio)
      const shrunk = dragCropRect(start, handle, -999, -999, bounds, ratio)
      for (const rect of [grown, shrunk]) {
        keeps(rect)
        expect(rect.x).toBeGreaterThanOrEqual(-1e-6)
        expect(rect.y).toBeGreaterThanOrEqual(-1e-6)
        expect(rect.x + rect.width).toBeLessThanOrEqual(bounds.width + 1e-6)
        expect(rect.y + rect.height).toBeLessThanOrEqual(bounds.height + 1e-6)
        expect(rect.height).toBeGreaterThanOrEqual(MIN_CROP_SIZE - 1e-6)
      }
    }
  })
})
