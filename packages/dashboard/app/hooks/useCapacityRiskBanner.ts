/*
FNXC:CapacityRisk 2026-06-24-00:00:
Capacity-risk banner signal + per-project dismiss, with a settings-hydrate guard so the banner doesn't flash on first load or on project change, and a re-enable-clears-dismissal behavior (re-enabling the banner or changing the threshold resurrects a previously-dismissed banner). Extracted from AppInner.
*/

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  computeCapacityRisk,
  DEFAULT_CAPACITY_RISK_TODO_THRESHOLD,
  type CapacityRiskSignal,
} from "@fusion/core";
import { getScopedItem, removeScopedItem, setScopedItem } from "../utils/projectStorage";
import { CAPACITY_RISK_DISMISSED_KEY } from "../utils/appLifecycle";
import { isReviewColumnRole, isWipColumnRole, type ColumnRoleFlags } from "../utils/columnRoles";

/*
FNXC:CapacityRisk 2026-10-12-06:14:
The banner's in-progress and in-review counts follow each task's column traits, so a board whose lanes are renamed is counted like the default board.
A task with no traits (remote node, first paint, a column its workflow no longer declares) is counted by its legacy column id through the shared role helpers.
*/
export function countCapacityRiskLanes(
  tasks: ReadonlyArray<{ readonly id: string; readonly column: string }>,
  columnFlagsByTaskId: ReadonlyMap<string, ColumnRoleFlags>,
): { inProgressCount: number; inReviewCount: number } {
  let inProgressCount = 0;
  let inReviewCount = 0;
  for (const task of tasks) {
    const flags = columnFlagsByTaskId.get(task.id);
    if (isWipColumnRole(flags, task.column)) inProgressCount += 1;
    if (isReviewColumnRole(flags, task.column)) inReviewCount += 1;
  }
  return { inProgressCount, inReviewCount };
}

export interface UseCapacityRiskBannerOptions {
  agentStats: { todoTaskCount?: number; idleNonEphemeralCount?: number } | null | undefined;
  inProgressCount: number;
  inReviewCount: number;
  capacityRiskBannerEnabled: boolean | undefined;
  capacityRiskTodoThreshold: number | undefined;
  settingsLoaded: boolean;
  currentProjectId: string | undefined;
}

export interface UseCapacityRiskBannerResult {
  signal: CapacityRiskSignal;
  dismissed: boolean;
  dismiss: () => void;
}

export function useCapacityRiskBanner({
  agentStats,
  inProgressCount,
  inReviewCount,
  capacityRiskBannerEnabled,
  capacityRiskTodoThreshold,
  settingsLoaded,
  currentProjectId,
}: UseCapacityRiskBannerOptions): UseCapacityRiskBannerResult {
  const [dismissed, setDismissed] = useState(
    () => getScopedItem(CAPACITY_RISK_DISMISSED_KEY, currentProjectId) === "true",
  );

  useEffect(() => {
    setDismissed(getScopedItem(CAPACITY_RISK_DISMISSED_KEY, currentProjectId) === "true");
  }, [currentProjectId]);

  const signal = useMemo(
    () =>
      computeCapacityRisk({
        todoCount: agentStats?.todoTaskCount ?? 0,
        inProgressCount,
        inReviewCount,
        idleNonEphemeralAgentCount: agentStats?.idleNonEphemeralCount ?? 0,
        threshold: capacityRiskTodoThreshold ?? DEFAULT_CAPACITY_RISK_TODO_THRESHOLD,
      }),
    [agentStats?.todoTaskCount, agentStats?.idleNonEphemeralCount, inProgressCount, inReviewCount, capacityRiskTodoThreshold],
  );

  const previousBannerEnabledRef = useRef(capacityRiskBannerEnabled);
  const previousThresholdRef = useRef(capacityRiskTodoThreshold);
  const previousProjectIdRef = useRef(currentProjectId);
  const settingsHydratedRef = useRef(false);

  useEffect(() => {
    if (!settingsLoaded) {
      return;
    }

    if (!settingsHydratedRef.current || previousProjectIdRef.current !== currentProjectId) {
      settingsHydratedRef.current = true;
      previousProjectIdRef.current = currentProjectId;
      previousBannerEnabledRef.current = capacityRiskBannerEnabled;
      previousThresholdRef.current = capacityRiskTodoThreshold;
      return;
    }

    const wasEnabled = previousBannerEnabledRef.current;
    const previousThreshold = previousThresholdRef.current;
    const bannerEnabledChangedToTrue = !wasEnabled && capacityRiskBannerEnabled;
    const thresholdChanged = previousThreshold !== capacityRiskTodoThreshold;

    if (bannerEnabledChangedToTrue || thresholdChanged) {
      removeScopedItem(CAPACITY_RISK_DISMISSED_KEY, currentProjectId);
      setDismissed(false);
    }

    previousProjectIdRef.current = currentProjectId;
    previousBannerEnabledRef.current = capacityRiskBannerEnabled;
    previousThresholdRef.current = capacityRiskTodoThreshold;
  }, [settingsLoaded, capacityRiskBannerEnabled, capacityRiskTodoThreshold, currentProjectId]);

  const dismiss = useCallback(() => {
    setScopedItem(CAPACITY_RISK_DISMISSED_KEY, "true", currentProjectId);
    setDismissed(true);
  }, [currentProjectId]);

  return { signal, dismissed, dismiss };
}
