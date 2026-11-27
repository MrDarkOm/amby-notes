import { describe, expect, it } from "vitest"
import {
  MAX_ATTACHED_FILES,
  MAX_FILE_BYTES,
  readTextFiles,
  useAttachmentStore,
} from "./attachments"

const file = (name: string, content: string | Uint8Array) =>
  new File([content as BlobPart], name, { type: "text/plain" })

describe("readTextFiles", () => {
  it("reads UTF-8 text files with their names", async () => {
    const { added, error } = await readTextFiles(
      [file("a.md", "# Привет"), file("b.txt", "text")],
      [],
    )
    expect(error).toBeNull()
    expect(added.map((item) => [item.name, item.text])).toEqual([
      ["a.md", "# Привет"],
      ["b.txt", "text"],
    ])
  })

  it("leaves out binary, empty and oversized files and reports the first reason", async () => {
    const binary = file("x.bin", new Uint8Array([0xff, 0xfe, 0x00, 0x80]))
    const nul = file("n.txt", "a\0b")
    const empty = file("e.txt", "  ")
    const big = file("big.txt", "x".repeat(MAX_FILE_BYTES + 1))
    const ok = file("ok.txt", "fine")
    const result = await readTextFiles([binary, nul, empty, big, ok], [])
    expect(result.added.map((item) => item.name)).toEqual(["ok.txt"])
    expect(result.error).toBe("notText")
    expect((await readTextFiles([big], [])).error).toBe("tooLarge")
  })

  it("stops at the limit on the number of files, counting the ones already attached", async () => {
    const existing = Array.from({ length: MAX_ATTACHED_FILES - 1 }, (_, i) => ({
      name: `f${i}.txt`,
      text: `t${i}`,
      size: 2,
    }))
    const result = await readTextFiles([file("a.txt", "a"), file("b.txt", "b")], existing)
    expect(result.added.map((item) => item.name)).toEqual(["a.txt"])
    expect(result.error).toBe("tooMany")
  })

  it("does not attach the same file twice", async () => {
    const first = await readTextFiles([file("a.txt", "same")], [])
    const second = await readTextFiles([file("a.txt", "same")], first.added)
    expect(second.added).toEqual([])
  })
})

describe("the attachment store", () => {
  it("keeps files per chat and clears them", () => {
    const store = useAttachmentStore.getState()
    store.add("c", [
      { name: "a", text: "x", size: 1 },
      { name: "b", text: "y", size: 1 },
    ])
    store.remove("c", 0)
    expect(useAttachmentStore.getState().files["c"]?.map((item) => item.name)).toEqual(["b"])
    expect(useAttachmentStore.getState().files["d"]).toBeUndefined()
    store.clear("c")
    expect(useAttachmentStore.getState().files["c"]).toEqual([])
  })
})
