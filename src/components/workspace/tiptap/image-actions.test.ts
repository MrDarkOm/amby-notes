import { describe, expect, it } from "vitest"

import { imageSaveFormat, imageSaveName } from "./image-actions"

describe("image actions", () => {
  it("keeps JPEG as JPEG and writes everything else as PNG", () => {
    expect(imageSaveFormat("assets/photo.JPG")).toBe("jpeg")
    expect(imageSaveFormat("https://site.test/a.jpeg?x=1")).toBe("jpeg")
    expect(imageSaveFormat("data:image/jpeg;base64,AAAA")).toBe("jpeg")
    expect(imageSaveFormat("assets/scheme.webp")).toBe("png")
    expect(imageSaveFormat("data:image/png;base64,AAAA")).toBe("png")
  })

  it("names a saved picture after itself, with the extension it is saved in", () => {
    expect(imageSaveName("assets/My%20photo.jpeg", "jpeg")).toBe("My photo.jpg")
    expect(imageSaveName("C:\\pics\\logo.gif", "png")).toBe("logo.png")
    expect(imageSaveName("data:image/png;base64,AAAA", "png")).toBe("image.png")
    expect(imageSaveName("a/b/we:ird?.png#x", "png")).toBe("we-ird.png")
  })
})
