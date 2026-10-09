import { describe, expect, it } from "vitest"

import { attachmentKind, isRemoteAddress } from "./attachment-kind"

describe("attachmentKind", () => {
  it("tells audio, video and PDF apart by extension, in any letter case", () => {
    expect(attachmentKind("assets/song.mp3")).toBe("audio")
    expect(attachmentKind("assets/Voice.M4A")).toBe("audio")
    expect(attachmentKind("assets/clip.mp4")).toBe("video")
    expect(attachmentKind("clip.WEBM")).toBe("video")
    expect(attachmentKind("assets/report.pdf")).toBe("pdf")
  })

  it("ignores an anchor or a query after the file name", () => {
    expect(attachmentKind("assets/report.pdf#page=3")).toBe("pdf")
    expect(attachmentKind("clip.mp4?t=5")).toBe("video")
  })

  it("leaves images, notes and unknown files alone", () => {
    expect(attachmentKind("assets/photo.png")).toBeNull()
    expect(attachmentKind("assets/diagram.svg")).toBeNull()
    expect(attachmentKind("Note")).toBeNull()
    expect(attachmentKind("assets/archive.zip")).toBeNull()
    expect(attachmentKind("")).toBeNull()
    expect(attachmentKind(null)).toBeNull()
  })

  it("does not take a folder named like a file, or a bare extension, for an attachment", () => {
    expect(attachmentKind("movie.mp4/readme")).toBeNull()
    expect(attachmentKind("assets/.mp3")).toBeNull()
    expect(attachmentKind("C:\\files\\talk.mp3")).toBe("audio")
  })
})

describe("isRemoteAddress", () => {
  it("recognizes addresses that lead outside the vault", () => {
    for (const address of [
      "https://example.com/a.mp4",
      "http://example.com/a.mp4",
      "//example.com/a.mp4",
      "data:audio/mp3;base64,AAAA",
      "blob:abc",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "asset://localhost/x.mp3",
    ]) {
      expect(isRemoteAddress(address), address).toBe(true)
    }
  })

  it("treats a path inside the vault as local", () => {
    expect(isRemoteAddress("assets/a.mp4")).toBe(false)
    expect(isRemoteAddress("../a.mp4")).toBe(false)
    expect(isRemoteAddress("C:\\files\\a.mp4")).toBe(false)
  })
})
