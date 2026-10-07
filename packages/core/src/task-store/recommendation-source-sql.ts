import { and, inArray, or, sql, type SQL } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";

/*
FNXC:TaskRecommendations 2026-10-07-12:56:
SQL twin of `isRecommendationSourceActionable`: complete lanes, or review lanes whose merge is confirmed.
Both the Insights list and the link write use it, so the read surface and the write guard cannot disagree about which parents are actionable.
Returns undefined when no lane can qualify, so callers keep their existing "nothing eligible" short circuit.
*/
export function recommendationSourceLaneFilter(
  completeColumns: ReadonlySet<string>,
  landedReviewColumns?: ReadonlySet<string>,
): SQL | undefined {
  const complete = [...completeColumns];
  const review = [...(landedReviewColumns ?? [])];
  const completeFilter = complete.length > 0 ? inArray(schema.project.tasks.column, complete) : undefined;
  const landedFilter = review.length > 0
    ? and(
      inArray(schema.project.tasks.column, review),
      sql`(${schema.project.tasks.mergeDetails} ->> 'mergeConfirmed') = 'true'`,
    )
    : undefined;
  if (completeFilter && landedFilter) return or(completeFilter, landedFilter);
  return completeFilter ?? landedFilter;
}
