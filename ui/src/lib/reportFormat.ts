import type { ColumnType } from "@/api/types";

export function alignForType(type: ColumnType | undefined): "left" | "right" {
  return type === "number" ? "right" : "left";
}

function asFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

export function applyFmt(value: unknown, pattern: string): string {
  const number = asFiniteNumber(value);
  if (number === null) return "—";
  const percent = pattern.endsWith("%");
  const numericPattern = percent ? pattern.slice(0, -1) : pattern;
  const decimal = numericPattern.indexOf(".");
  const fractionDigits = decimal < 0 ? 0 : numericPattern.length - decimal - 1;
  return new Intl.NumberFormat("en-US", {
    useGrouping: numericPattern.includes(","),
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
    style: percent ? "percent" : "decimal",
  }).format(number);
}

export function formatByType(value: unknown, type: ColumnType | undefined): string {
  if (value === null || value === undefined) return "—";
  if (type === "number") {
    const number = asFiniteNumber(value);
    if (number === null) return String(value);
    return new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 }).format(number);
  }
  if (type === "boolean") return value ? "true" : "false";
  if (type === "date") {
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}
