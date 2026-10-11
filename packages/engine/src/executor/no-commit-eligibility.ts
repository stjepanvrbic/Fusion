/**
 * FNXC:CodeOrganization 2026-08-03-07:20:
 * noCommitsExpected eligibility heuristics peeled from executor.ts (wave18 / U4 Slice A).
 */
import type { Task } from "@fusion/core";
import { extractFileScopeSection, extractPlanSection, listPlanHeadings } from "@fusion/core";

/*
FNXC:PlanSections 2026-10-11-17:08:
Mission and Review Level come from the core plan-section locator, so coordination-only wording or a Plan Only level quoted in the Original Description cannot exempt a source task from producing commits.
*/
function getPromptSection(prompt: string, heading: string): string {
  return extractPlanSection(prompt, heading)?.trim() ?? "";
}

function promptDeclaresReviewLevelOnePlanOnly(prompt: string): boolean {
  return listPlanHeadings(prompt).some((heading) => /^Review Level:\s*1\b.*\bPlan Only\b/i.test(heading.text));
}

function promptDeclaresNoSourceChangeIntent(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return [
    /should\s+not\s+change\s+(?:product\s+)?source/,
    /do\s+not\s+(?:edit|modify|change)\s+(?:product\s+)?source/,
    /no\s+(?:source|code)\s+changes?\s+(?:are\s+)?(?:expected|required|needed|allowed)/,
    /must\s+not\s+(?:edit|modify|change)\s+(?:product\s+)?(?:source|code)/,
  ].some((pattern) => pattern.test(normalized));
}

function promptLooksCoordinationOnly(prompt: string): boolean {
  const titleMatch = prompt.match(/^#\s+Task:\s+[^\n]+/im)?.[0] ?? "";
  const mission = getPromptSection(prompt, "Mission");
  const assessment = prompt.match(/^\*\*Assessment:\*\*\s*([^\n]+)/im)?.[1] ?? "";
  const coordinationText = `${titleMatch}\n${mission}\n${assessment}`.toLowerCase();
  const hasCoordinationIntent = /\b(coordination|routing|route|handoff|assign(?:ment)?|owner|triage|select exactly one|record (?:the )?intentional block)\b/.test(coordinationText);
  const missionLower = mission.toLowerCase()
    .replace(/do\s+not\s+(?:edit|modify|change)\s+(?:product\s+)?source/g, "")
    .replace(/should\s+not\s+change\s+(?:product\s+)?source/g, "")
    .replace(/must\s+not\s+(?:edit|modify|change)\s+(?:product\s+)?(?:source|code)/g, "");
  const hasImplementationDirective = /\b(implement|fix|add|change|modify|refactor|build|create|delete|remove)\b/.test(missionLower);
  return hasCoordinationIntent && !hasImplementationDirective;
}

/**
 * FNXC:FileScope 2026-10-11-14:50:
 * The section comes from the core locator, so board-only wording in a File Scope list quoted in the Original Description cannot make a source task look coordination-only.
 */
function promptFileScopeIsBoardOnly(prompt: string): boolean {
  const fileScope = (extractFileScopeSection(prompt) ?? "").trim();
  if (!fileScope.trim()) return false;
  const normalized = fileScope.toLowerCase();
  const sourcePathPattern = /(?:^|[\s`'"(])(?:packages|src|source|sources|app|apps|lib|libs|components|scripts|docs|\.github|config|test|tests|__tests__)\//m;
  const sourceExtensionPattern = /\.(?:ts|tsx|js|jsx|mjs|cjs|swift|kt|java|py|go|rs|rb|php|cs|cpp|c|h|hpp|json|ya?ml|toml|mdx?|css|scss|html|sql|sh)\b/m;
  if (sourcePathPattern.test(normalized) || sourceExtensionPattern.test(normalized)) return false;
  const allowedBoardOnlyPattern = /(?:^|[^\w/])(?:task[- ]?board|board task|task document|task documents|task metadata|task logs|fusion task tools|fn_task_[\w-]*|\.fusion\/tasks|attachments?)(?=$|[^\w/-])/;
  return allowedBoardOnlyPattern.test(normalized);
}

export function getNoCommitEligibilityReason(task: Task): "explicit noCommitsExpected=true" | "prompt-derived coordination-only no-source scope" | null {
  if (task.noCommitsExpected === true) return "explicit noCommitsExpected=true";
  const rawPrompt = task.prompt;
  const prompt = typeof rawPrompt === "string" ? rawPrompt : "";
  if (!prompt.trim()) return null;
  if (
    promptDeclaresReviewLevelOnePlanOnly(prompt) &&
    promptLooksCoordinationOnly(prompt) &&
    promptDeclaresNoSourceChangeIntent(prompt) &&
    promptFileScopeIsBoardOnly(prompt)
  ) {
    return "prompt-derived coordination-only no-source scope";
  }
  return null;
}
