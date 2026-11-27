/** A rectangle in pixels of the picture as it is shown (or of the file, once scaled). */
export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

/** The part of a crop frame the pointer holds: an edge, a corner, or the whole frame. */
export type CropHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw" | "move"

export const MIN_CROP_SIZE = 40

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * The frame after the pointer moved by (dx, dy) while holding `handle`. The frame stays
 * inside the picture (`bounds`) and never gets smaller than `MIN_CROP_SIZE`.
 */
export function dragCropRect(
  start: CropRect,
  handle: CropHandle,
  dx: number,
  dy: number,
  bounds: { width: number; height: number },
  /** Width over height the frame keeps; free when absent. */
  ratio?: number,
): CropRect {
  if (handle === "move") {
    return {
      x: clamp(start.x + dx, 0, bounds.width - start.width),
      y: clamp(start.y + dy, 0, bounds.height - start.height),
      width: start.width,
      height: start.height,
    }
  }
  let left = start.x
  let top = start.y
  let right = start.x + start.width
  let bottom = start.y + start.height
  if (handle.includes("w")) left = clamp(left + dx, 0, right - MIN_CROP_SIZE)
  if (handle.includes("e")) right = clamp(right + dx, left + MIN_CROP_SIZE, bounds.width)
  if (handle.includes("n")) top = clamp(top + dy, 0, bottom - MIN_CROP_SIZE)
  if (handle.includes("s")) bottom = clamp(bottom + dy, top + MIN_CROP_SIZE, bounds.height)
  const free = { x: left, y: top, width: right - left, height: bottom - top }
  return ratio ? lockRatio(start, handle, free, bounds, ratio) : free
}

/** The largest frame of the given ratio that fits the picture, in its middle. */
export function fitCropRatio(bounds: { width: number; height: number }, ratio: number): CropRect {
  const width = Math.min(bounds.width, bounds.height * ratio)
  const height = width / ratio
  return { x: (bounds.width - width) / 2, y: (bounds.height - height) / 2, width, height }
}

/** A frame as the pointer left it, made to keep `ratio` and to stay inside the picture. */
function lockRatio(
  start: CropRect,
  handle: Exclude<CropHandle, "move">,
  free: CropRect,
  bounds: { width: number; height: number },
  ratio: number,
): CropRect {
  const left = start.x
  const right = start.x + start.width
  const top = start.y
  const bottom = start.y + start.height
  let width = free.width
  let height = free.height

  if (handle.length === 2) {
    // A corner holds the opposite one still; the dimension that was pulled further decides.
    const anchorX = handle.includes("w") ? right : left
    const anchorY = handle.includes("n") ? bottom : top
    width = Math.max(width, height * ratio)
    height = width / ratio
    const room = Math.min(
      (handle.includes("w") ? anchorX : bounds.width - anchorX) / width,
      (handle.includes("n") ? anchorY : bounds.height - anchorY) / height,
      1,
    )
    width *= room
    height *= room
    ;[width, height] = minimumSize(width, height, ratio)
    return {
      x: handle.includes("w") ? anchorX - width : anchorX,
      y: handle.includes("n") ? anchorY - height : anchorY,
      width,
      height,
    }
  }

  if (handle === "e" || handle === "w") {
    // The far edge stays; the frame grows from the middle of its height.
    const middle = top + start.height / 2
    const roomY = 2 * Math.min(middle, bounds.height - middle)
    const roomX = handle === "e" ? bounds.width - left : right
    height = width / ratio
    if (height > roomY) {
      height = roomY
      width = height * ratio
    }
    if (width > roomX) {
      width = roomX
      height = width / ratio
    }
    ;[width, height] = minimumSize(width, height, ratio)
    return { x: handle === "e" ? left : right - width, y: middle - height / 2, width, height }
  }

  const middle = left + start.width / 2
  const roomX = 2 * Math.min(middle, bounds.width - middle)
  const roomY = handle === "s" ? bounds.height - top : bottom
  width = height * ratio
  if (width > roomX) {
    width = roomX
    height = width / ratio
  }
  if (height > roomY) {
    height = roomY
    width = height * ratio
  }
  ;[width, height] = minimumSize(width, height, ratio)
  return { x: middle - width / 2, y: handle === "s" ? top : bottom - height, width, height }
}

function minimumSize(width: number, height: number, ratio: number): [number, number] {
  if (height < MIN_CROP_SIZE) return [MIN_CROP_SIZE * ratio, MIN_CROP_SIZE]
  if (width < MIN_CROP_SIZE) return [MIN_CROP_SIZE, MIN_CROP_SIZE / ratio]
  return [width, height]
}

/** The frame in the file's own pixels, from the frame on the shown picture. */
export function scaleCropRect(rect: CropRect, scale: number, limit: CropRect): CropRect {
  const x = clamp(Math.round(rect.x * scale), 0, limit.width - 1)
  const y = clamp(Math.round(rect.y * scale), 0, limit.height - 1)
  return {
    x,
    y,
    width: clamp(Math.round(rect.width * scale), 1, limit.width - x),
    height: clamp(Math.round(rect.height * scale), 1, limit.height - y),
  }
}
