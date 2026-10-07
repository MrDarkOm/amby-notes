import { describe, it, expect, vi } from "vitest"
import { stripYamlFrontmatter, compileManuscript, type ManuscriptNode } from "./manuscript-compiler"

describe("manuscript-compiler (CR-12, CR-13, CR-19)", () => {
  describe("stripYamlFrontmatter", () => {
    it("strips standard YAML frontmatter", () => {
      const raw = `---
title: Глава 1
status: in-progress
---
Это основной текст главы.
Вторая строка текста.`

      const stripped = stripYamlFrontmatter(raw)
      expect(stripped).toBe("Это основной текст главы.\nВторая строка текста.")
    })

    it("returns plain markdown unchanged when no frontmatter", () => {
      const raw = "Простой текст без метаданных."
      expect(stripYamlFrontmatter(raw)).toBe("Простой текст без метаданных.")
    })

    it("handles empty or whitespace strings", () => {
      expect(stripYamlFrontmatter("")).toBe("")
    })
  })

  describe("compileManuscript", () => {
    it("compiles book, chapters in body mode, and chapters in scenes mode", async () => {
      const notes: Record<string, string> = {
        chap_1: `---
title: Пролог
---
Начало великой истории.`,
        scene_1: `---
title: Встреча в таверне
---
За столом сидели трое.`,
        scene_2: `---
title: Побег
---
Они выбежали в темноту.`,
      }

      const readNoteContent = vi.fn(async (_vault: string, noteId: string) => {
        return notes[noteId] || ""
      })

      const tree: ManuscriptNode[] = [
        {
          noteId: "book_1",
          title: "Пепельный берег",
          type: "book",
          order: "a0",
          children: [
            {
              noteId: "chap_1",
              title: "Пролог",
              type: "chapter",
              order: "a0",
              chapterMode: "body",
              children: [],
            },
            {
              noteId: "chap_2",
              title: "Глава 1: Тени",
              type: "chapter",
              order: "a1",
              chapterMode: "scenes",
              children: [
                {
                  noteId: "scene_1",
                  title: "Встреча в таверне",
                  type: "scene",
                  order: "a0",
                  children: [],
                },
                {
                  noteId: "scene_2",
                  title: "Побег",
                  type: "scene",
                  order: "a1",
                  children: [],
                },
              ],
            },
          ],
        },
      ]

      const compiled = await compileManuscript({
        vaultPath: "/vault",
        rootNodes: tree,
        readNoteContent,
        includeSceneHeaders: true,
      })

      expect(compiled).toContain("# Пепельный берег")
      expect(compiled).toContain("## Пролог")
      expect(compiled).toContain("Начало великой истории.")
      expect(compiled).toContain("## Глава 1: Тени")
      expect(compiled).toContain("### Встреча в таверне")
      expect(compiled).toContain("За столом сидели трое.")
      expect(compiled).toContain("### Побег")
      expect(compiled).toContain("Они выбежали в темноту.")
      // Verifies frontmatter markers are stripped
      expect(compiled).not.toContain("---")
    })
  })
})
