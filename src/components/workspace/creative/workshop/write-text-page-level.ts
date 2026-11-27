import { applyDatabaseValueBatch, type ProjectTextSummary } from "@/lib/storage"
import type { TextNode } from "./text-tree-model"

export function writeTextPageLevel(
  text: ProjectTextSummary,
  generation: number,
  node: TextNode,
  levelId: string,
) {
  if (!text.databaseId || !text.properties.level) return Promise.resolve()
  return applyDatabaseValueBatch({
    expectedGeneration: generation,
    databaseId: text.databaseId,
    operationId: `level-${crypto.randomUUID()}`,
    cells: [
      {
        noteId: node.noteId,
        propertyId: text.properties.level,
        valueJson: JSON.stringify({ type: "select", optionId: levelId }),
        expectedRevision: node.revision,
      },
    ],
  })
}
