import type { DatabasePropertySummary, DatabaseSummary } from "@/lib/storage"
import registry from "./rollup-aggregations.json"

/**
 * What the Rollup wizard offers. The aggregation table is `rollup-aggregations.json`,
 * the same file the Rust registry test checks, so the wizard cannot offer a
 * combination the backend refuses.
 */

export interface RollupDraft {
  relationId: string
  targetId: string
  aggregation: string
}

export const EMPTY_ROLLUP_DRAFT: RollupDraft = { relationId: "", targetId: "", aggregation: "" }

const AGGREGATIONS = registry as Record<string, string[]>

export function aggregationsFor(kind: string): string[] {
  return AGGREGATIONS[kind] ?? []
}

export function relationPropertiesOf(
  database: DatabaseSummary | undefined,
): DatabasePropertySummary[] {
  return (database?.properties ?? []).filter((property) => property.propertyType === "relation")
}

export function relationTargetDatabaseId(
  relation: DatabasePropertySummary | undefined,
  fallback: string,
): string {
  if (!relation) return fallback
  try {
    const config = JSON.parse(relation.configJson) as { targetDatabaseId?: unknown }
    return typeof config.targetDatabaseId === "string" ? config.targetDatabaseId : fallback
  } catch {
    return fallback
  }
}

/** Fields of the related database that at least one aggregation can summarize. */
export function targetPropertiesFor(
  relation: DatabasePropertySummary | undefined,
  databases: DatabaseSummary[],
  currentDatabaseId: string,
  ownPropertyId?: string,
): DatabasePropertySummary[] {
  if (!relation) return []
  const targetId = relationTargetDatabaseId(relation, currentDatabaseId)
  const target = databases.find((database) => database.databaseId === targetId)
  return (target?.properties ?? []).filter(
    (property) =>
      !(targetId === currentDatabaseId && property.propertyId === ownPropertyId) &&
      aggregationsFor(property.propertyType).length > 0,
  )
}

/** The draft after the user changed one choice: later choices that no longer fit are cleared. */
export function nextDraft(
  draft: RollupDraft,
  change: Partial<RollupDraft>,
  context: {
    database: DatabaseSummary | undefined
    databases: DatabaseSummary[]
    currentDatabaseId: string
    ownPropertyId?: string
  },
): RollupDraft {
  const next = { ...draft, ...change }
  const relation = relationPropertiesOf(context.database).find(
    (property) => property.propertyId === next.relationId,
  )
  const targets = targetPropertiesFor(
    relation,
    context.databases,
    context.currentDatabaseId,
    context.ownPropertyId,
  )
  const target = targets.find((property) => property.propertyId === next.targetId)
  if (!target) return { ...next, targetId: "", aggregation: "" }
  if (!aggregationsFor(target.propertyType).includes(next.aggregation)) {
    return { ...next, aggregation: "" }
  }
  return next
}

export function isDraftComplete(draft: RollupDraft): boolean {
  return Boolean(draft.relationId && draft.targetId && draft.aggregation)
}

/** Whether the result is a share (shown with a percent sign). */
export function isPercentAggregation(aggregation: string): boolean {
  return aggregation === "percentChecked"
}
