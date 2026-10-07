import { ApiRequestError } from "../api/client/client";

/*
FNXC:TaskRecommendations 2026-10-07-19:59:
Every recommendation surface (Insights, task detail, mailbox notice) presents a failed Create task the same way.
A 4xx refusal is a domain answer the operator can act on, such as "file this after the source lands", so its server text is shown; transport and 5xx failures return null and keep the generic retry prompt.
*/
export function recommendationCreateRefusalReason(cause: unknown): string | null {
  if (!(cause instanceof ApiRequestError) || cause.status < 400 || cause.status >= 500) return null;
  const message = cause.message.trim();
  return message.length > 0 ? message : null;
}
