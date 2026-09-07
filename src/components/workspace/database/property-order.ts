export type PropertyDropEdge = "before" | "after"

export function movePropertyId(
  propertyIds: string[],
  sourceId: string,
  targetId: string,
  edge: PropertyDropEdge,
): string[] {
  if (sourceId === targetId || !propertyIds.includes(sourceId) || !propertyIds.includes(targetId)) {
    return propertyIds
  }
  const remaining = propertyIds.filter((id) => id !== sourceId)
  const targetIndex = remaining.indexOf(targetId)
  const insertionIndex = targetIndex + (edge === "after" ? 1 : 0)
  const next = [...remaining]
  next.splice(insertionIndex, 0, sourceId)
  return next
}
