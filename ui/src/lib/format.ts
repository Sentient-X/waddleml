import type { StatusTone } from "@sx/ui";

import type { RunState } from "@/api/types";

export function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

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

export function formatDateTime(iso: string): string {
  return new Date(iso).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

export function runDuration(startedAt: string, finishedAt: string | null): string {
  const elapsedSeconds = Math.max(
    0,
    (new Date(finishedAt ?? Date.now()).getTime() - new Date(startedAt).getTime()) / 1000,
  );
  if (elapsedSeconds < 60) return `${elapsedSeconds.toFixed(elapsedSeconds < 10 ? 1 : 0)}s`;
  if (elapsedSeconds < 3600) return `${Math.floor(elapsedSeconds / 60)}m ${Math.floor(elapsedSeconds % 60)}s`;
  return `${Math.floor(elapsedSeconds / 3600)}h ${Math.floor((elapsedSeconds % 3600) / 60)}m`;
}

export function runStateTone(state: RunState): StatusTone {
  if (state === "running") return "live";
  if (state === "completed") return "ok";
  if (state === "failed") return "error";
  return "idle";
}

export function shortHash(value: string, length = 8): string {
  return value.slice(0, length);
}
