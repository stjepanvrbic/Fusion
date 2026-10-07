/*
FNXC:TaskRetry 2026-10-07-17:57:
Provenance carried by every operator retry move (`fn task retry` and `fn_task_retry`).
Retry moves pass no `moveSource`: "user" would park the card userPaused in the hold lane, and "engine"/"scheduler" would be refused by lifecycle containment for a backward move. This label keeps the move attributable in the move log and identifiable to the move-source census.
*/
export const MANUAL_RETRY_MOVE_PROVENANCE = "manual-retry";
