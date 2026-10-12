/**
 * FNXC:ReviewFailureReason 2026-10-12-03:04:
 * A failed review step must never record a blank or junk reason ("failed before producing a verdict: failed", ": undefined", ": [object Object]").
 * A non-blank message is returned unchanged (not trimmed), so provider classification of message-bearing errors is byte-identical to before.
 * An Error with an empty message reports its type, code, exit code, signal, stderr tail and cause, so a provider or network signal hidden in that detail (for example a 429 cause) is still classified.
 * Any other value reports itself as the rejection value under a fixed text that says the subject failed without an error message.
 */

/** Fixed text appended to the subject when the thrown value carries no error message. */
export const FAILED_WITHOUT_ERROR_MESSAGE = "failed without an error message";

const DETAIL_CHARACTER_LIMIT = 500;
const MAX_CAUSE_DEPTH = 3;

export function describeFailure(err: unknown, subject: string): string {
  return describe(err, subject, 0, new Set<unknown>());
}

function describe(err: unknown, subject: string, depth: number, seen: Set<unknown>): string {
  const message = nonBlankMessage(err);
  if (message !== undefined) return message;
  const details = err instanceof Error
    ? errorDetails(err, subject, depth, seen)
    : [`rejection value: ${rejectionValue(err)}`];
  return `${subject} ${FAILED_WITHOUT_ERROR_MESSAGE} (${details.join("; ")})`;
}

function nonBlankMessage(err: unknown): string | undefined {
  if (typeof err === "string") return err.trim() ? err : undefined;
  if (typeof err !== "object" || err === null) return undefined;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? message : undefined;
}

function errorDetails(err: Error, subject: string, depth: number, seen: Set<unknown>): string[] {
  seen.add(err);
  const fields = err as Error & { code?: unknown; exitCode?: unknown; signal?: unknown; stderr?: unknown };
  const details = [`error type: ${errorType(err)}`];
  if ((typeof fields.code === "string" && fields.code.trim()) || isFiniteNumber(fields.code)) {
    details.push(`code: ${String(fields.code).trim()}`);
  }
  if (isFiniteNumber(fields.exitCode)) details.push(`exit code: ${fields.exitCode}`);
  if (typeof fields.signal === "string" && fields.signal.trim()) details.push(`signal: ${fields.signal.trim()}`);
  const stderr = stderrTail(fields.stderr);
  if (stderr) details.push(`stderr: ${stderr}`);
  const cause = err.cause;
  if (cause !== undefined && cause !== null && depth < MAX_CAUSE_DEPTH && !seen.has(cause)) {
    details.push(`cause: ${describe(cause, subject, depth + 1, seen)}`);
  }
  return details;
}

function errorType(err: Error): string {
  if (typeof err.name === "string" && err.name.trim()) return err.name.trim();
  const constructorName = (err as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof constructorName === "string" && constructorName.trim() ? constructorName.trim() : "Error";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function stderrTail(stderr: unknown): string | undefined {
  const raw = typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString("utf8") : undefined;
  const collapsed = raw?.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  return collapsed.length > DETAIL_CHARACTER_LIMIT ? `…${collapsed.slice(-DETAIL_CHARACTER_LIMIT)}` : collapsed;
}

function rejectionValue(value: unknown): string {
  if (typeof value === "string") return "empty string";
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return String(value);
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = undefined;
  }
  if (serialized === undefined) return Object.prototype.toString.call(value);
  return serialized.length > DETAIL_CHARACTER_LIMIT ? `${serialized.slice(0, DETAIL_CHARACTER_LIMIT)}…` : serialized;
}
