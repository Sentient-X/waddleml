/* What's left after the platform formatting vocabulary (@sx/ui) took the
   shared semantics: the two waddle-domain formatters. Everything else —
   counts, timestamps, durations, hashes — comes from @sx/ui. */

import type { StatusTone } from "@sx/ui";

import type { RunState } from "@/api/types";

/** Any logged config/summary value, rendered for a metadata tree: exponential
 *  at the extremes, six significant digits in the readable middle. */
export function formatScalar(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return String(value);
    if (value === 0) return "0";
    const magnitude = Math.abs(value);
    if (magnitude >= 10_000 || magnitude < 0.001) return value.toExponential(3);
    return new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 }).format(value);
  }
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null || value === undefined) return "—";
  return JSON.stringify(value);
}

export function runStateTone(state: RunState): StatusTone {
  if (state === "running") return "live";
  if (state === "completed") return "ok";
  if (state === "failed") return "error";
  return "idle";
}
