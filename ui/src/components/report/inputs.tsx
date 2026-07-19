/* Report input components — the interactivity loop. Each binds to one report
   param: it reads the current (effective) value from the render's echoed params
   and, on change, calls back so the page updates its param state and re-renders.
   When no `onParamChange` is wired (a static/non-interactive render) inputs show
   their value but are disabled. Options come from a backing query OR a static
   `options="a,b,c"` list. */

import { useEffect, useState } from "react";
import { Input, cn } from "@sx/ui";

import type { SqlResult } from "@/api/types";

export interface InputRenderProps {
  props: Record<string, string>;
  result?: SqlResult;
  params: Record<string, string>;
  onParamChange?: (name: string, value: string) => void;
}

interface Option {
  value: string;
  label: string;
}

function columnIndex(result: SqlResult, name: string): number {
  return result.columns.indexOf(name);
}

/** Static `options="a,b,c"` first, else (value,label) pairs from the query. */
function resolveOptions(props: Record<string, string>, result?: SqlResult): Option[] {
  if (props.options) {
    return props.options
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((v) => ({ value: v, label: v }));
  }
  if (!result) return [];
  const vi = columnIndex(result, props.value ?? "");
  if (vi < 0) return [];
  const li = props.label ? columnIndex(result, props.label) : -1;
  const out: Option[] = [];
  const seen = new Set<string>();
  for (const row of result.rows) {
    const value = String(row[vi]);
    if (seen.has(value)) continue;
    seen.add(value);
    out.push({ value, label: li >= 0 ? String(row[li]) : value });
  }
  return out;
}

function Field({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="font-mono text-muted-foreground">{name}</span>
      {children}
    </label>
  );
}

export function Dropdown({ props, result, params, onParamChange }: InputRenderProps) {
  const name = props.name ?? "";
  const options = resolveOptions(props, result);
  const value = params[name] ?? "";
  return (
    <Field name={props.title ?? name}>
      <select
        value={value}
        disabled={!onParamChange}
        onChange={(e) => onParamChange?.(name, e.target.value)}
        className="h-8 w-44 rounded-md border border-input bg-transparent px-2 text-xs disabled:opacity-50"
      >
        {value === "" ? <option value="">—</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function ButtonGroup({ props, result, params, onParamChange }: InputRenderProps) {
  const name = props.name ?? "";
  const options = resolveOptions(props, result);
  const value = params[name] ?? "";
  return (
    <Field name={props.title ?? name}>
      <div className="inline-flex rounded-md border border-input p-0.5">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            disabled={!onParamChange}
            onClick={() => onParamChange?.(name, o.value)}
            className={cn(
              "rounded px-2.5 py-1 text-xs transition-colors disabled:opacity-50",
              o.value === value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </Field>
  );
}

/** Debounced free-text — commits `delayMs` after typing settles. Local state
 *  seeds from (and re-syncs to) the effective param. */
function useDebouncedParam(
  name: string,
  current: string,
  delayMs: number,
  onParamChange?: (name: string, value: string) => void,
): [string, (v: string) => void] {
  const [val, setVal] = useState(current);
  // Re-sync when the effective value changes externally (URL, other input).
  useEffect(() => setVal(current), [current]);
  useEffect(() => {
    if (!onParamChange || val === current) return;
    const t = setTimeout(() => onParamChange(name, val), delayMs);
    return () => clearTimeout(t);
  }, [val, current, name, delayMs, onParamChange]);
  return [val, setVal];
}

export function TextInput({ props, params, onParamChange }: InputRenderProps) {
  const name = props.name ?? "";
  const [val, setVal] = useDebouncedParam(name, params[name] ?? "", 500, onParamChange);
  return (
    <Field name={props.title ?? name}>
      <Input
        value={val}
        disabled={!onParamChange}
        placeholder={props.placeholder ?? name}
        onChange={(e) => setVal(e.target.value)}
        className="h-8 w-44 text-xs"
      />
    </Field>
  );
}

export function Slider({ props, params, onParamChange }: InputRenderProps) {
  const name = props.name ?? "";
  const min = Number(props.min ?? "0");
  const max = Number(props.max ?? "100");
  const step = Number(props.step ?? "1");
  const fallback = params[name] ?? String(min);
  const [val, setVal] = useDebouncedParam(name, fallback, 300, onParamChange);
  return (
    <Field name={props.title ?? name}>
      <span className="flex items-center gap-2">
        <input
          type="range"
          value={val}
          min={Number.isFinite(min) ? min : 0}
          max={Number.isFinite(max) ? max : 100}
          step={Number.isFinite(step) && step > 0 ? step : 1}
          disabled={!onParamChange}
          onChange={(e) => setVal(e.target.value)}
          className="w-40 disabled:opacity-50"
        />
        <span className="w-10 font-mono tabular-nums text-muted-foreground">{val}</span>
      </span>
    </Field>
  );
}

/** The input component names, so the pages can compute which required params
 *  still need the crude fallback bar (required minus those with an input). */
export const INPUT_COMPONENTS = new Set(["Dropdown", "ButtonGroup", "TextInput", "Slider"]);
