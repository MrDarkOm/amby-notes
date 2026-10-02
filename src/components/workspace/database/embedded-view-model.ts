import type { DatabasePropertySummary } from "@/lib/storage"
import {
  conditionsToFilter,
  flatConditions,
  type DurableFilter,
  type ViewCondition,
} from "./view-config"
import { relationTargetDatabaseId } from "./rollup-model"

/** The filter operand that stands for the page a view is embedded on. */
export const CURRENT_PAGE_OPERAND = "@currentPage"

/**
 * The embedding's own filter next to the shared view's: both must hold. An
 * embedding that sets no filter simply shows the shared view as saved.
 */
export function combineFilters(
  viewFilter: DurableFilter | null,
  embedFilter: unknown,
): DurableFilter | null {
  const own =
    embedFilter &&
    typeof embedFilter === "object" &&
    typeof (embedFilter as DurableFilter).kind === "string"
      ? (embedFilter as DurableFilter)
      : null
  if (viewFilter && own) return { kind: "group", operator: "and", children: [viewFilter, own] }
  return viewFilter ?? own
}

/** "This relation points at the page the view is on". */
export function currentPageFilter(relationPropertyId: string): DurableFilter {
  return conditionsToFilter([
    {
      field: { kind: "property", propertyId: relationPropertyId },
      operator: "contains",
      operand: CURRENT_PAGE_OPERAND,
    },
  ]) as DurableFilter
}

function isCurrentPage(condition: ViewCondition): boolean {
  return condition.operand === CURRENT_PAGE_OPERAND && condition.field.kind === "property"
}

/** Relation properties a filter ties to the current page, in order. */
export function currentPageRelations(filter: DurableFilter | null): string[] {
  return (flatConditions(filter) ?? [])
    .filter(isCurrentPage)
    .map((condition) => (condition.field.kind === "property" ? condition.field.propertyId : ""))
    .filter(Boolean)
}

/**
 * Whether the filter has anything besides the current-page ties. A record created
 * in such a view is linked to the page, but another condition may still hide it.
 */
export function hasOtherConditions(filter: DurableFilter | null): boolean {
  const conditions = flatConditions(filter)
  if (conditions === null) return true
  return conditions.some((condition) => !isCurrentPage(condition))
}

/** Relation properties of the embedded database that point at the page's own database. */
export function pageRelationCandidates(
  properties: DatabasePropertySummary[],
  pageDatabaseId: string | null,
  embeddedDatabaseId: string,
): DatabasePropertySummary[] {
  if (!pageDatabaseId) return []
  return properties.filter(
    (property) =>
      property.propertyType === "relation" &&
      relationTargetDatabaseId(property, embeddedDatabaseId) === pageDatabaseId,
  )
}
