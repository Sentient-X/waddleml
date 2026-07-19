/* One chart panel with W&B-style incremental disclosure: the chart is plain by
   default; a gear opens per-panel settings (log scale, EMA smoothing — persisted
   per metric in localStorage) and a menu bridges the panel into reports-as-code
   by emitting its own sql fence + component markup. */

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Copy, FilePlus2, MoreVertical, Settings2 } from "lucide-react";
import { cn } from "@sx/ui";

import { MetricChart, type ChartSeries } from "@/components/MetricChart";

const SETTINGS_PREFIX = "waddle:panel:";
/** sessionStorage key the report editor reads to seed a new draft. */
export const REPORT_DRAFT_KEY = "waddle:report-draft";

interface PanelSettings {
  yLog: boolean;
  smooth: number; // EMA weight 0 (off) … 0.95
}

const DEFAULTS: PanelSettings = { yLog: false, smooth: 0 };

function loadSettings(metric: string): PanelSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_PREFIX + metric);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<PanelSettings>;
    return {
      yLog: parsed.yLog === true,
      smooth: typeof parsed.smooth === "number" ? Math.min(0.95, Math.max(0, parsed.smooth)) : 0,
    };
  } catch {
    return DEFAULTS;
  }
}

function ema(points: readonly { step: number; value: number }[], weight: number) {
  if (weight <= 0) return [...points];
  let acc: number | null = null;
  return points.map((p) => {
    acc = acc === null ? p.value : weight * acc + (1 - weight) * p.value;
    return { step: p.step, value: acc };
  });
}

/** The panel's report markup: the project-wide, run-pivoted query — the shape
 *  a report wants (comparative), not the page's single-run fetch. */
export function panelReportMarkup(metric: string, project: string, yLog: boolean): string {
  const slug = metric.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
  return [
    "```sql " + slug,
    "select r.name as run_name, (m.step // 25) * 25 as step, avg(m.value) as value",
    "from metrics m join runs r using (run_id)",
    `where m.metric_name = '${metric}' and r.project = '${project}'`,
    "group by 1, 2 order by 1, 2",
    "```",
    "",
    `<LineChart data={${slug}} x=step y=value series=run_name${yLog ? " yLog=true" : ""} title="${metric}" />`,
  ].join("\n");
}

export function MetricPanel({
  metric,
  project,
  series,
  height = 170,
}: {
  metric: string;
  project: string;
  series: readonly ChartSeries[];
  height?: number;
}) {
  const navigate = useNavigate();
  const [settings, setSettings] = useState<PanelSettings>(() => loadSettings(metric));
  const [open, setOpen] = useState<"settings" | "menu" | null>(null);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  function update(patch: Partial<PanelSettings>) {
    setSettings((cur) => {
      const next = { ...cur, ...patch };
      try {
        if (next.yLog === DEFAULTS.yLog && next.smooth === DEFAULTS.smooth) {
          localStorage.removeItem(SETTINGS_PREFIX + metric);
        } else {
          localStorage.setItem(SETTINGS_PREFIX + metric, JSON.stringify(next));
        }
      } catch {
        // storage unavailable — settings stay session-local
      }
      return next;
    });
  }

  const markup = () => panelReportMarkup(metric, project, settings.yLog);
  const shown = series.map((s) => ({ ...s, points: ema(s.points, settings.smooth) }));
  const customized = settings.yLog || settings.smooth > 0;

  return (
    <div ref={rootRef} className="relative rounded-lg border p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{metric}</span>
        <span className="flex shrink-0 items-center gap-1">
          {customized ? (
            <span className="text-[10px] text-muted-foreground">
              {settings.yLog ? "log" : ""}
              {settings.yLog && settings.smooth > 0 ? " · " : ""}
              {settings.smooth > 0 ? `ema ${settings.smooth.toFixed(2)}` : ""}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => setOpen(open === "settings" ? null : "settings")}
            className={cn(
              "rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground",
              open === "settings" && "bg-accent text-foreground",
            )}
            aria-label={`Settings for ${metric}`}
          >
            <Settings2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setOpen(open === "menu" ? null : "menu")}
            className={cn(
              "rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground",
              open === "menu" && "bg-accent text-foreground",
            )}
            aria-label={`Actions for ${metric}`}
          >
            <MoreVertical className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>

      {open === "settings" ? (
        <div className="absolute right-2 top-9 z-20 w-56 rounded-lg border bg-popover p-3 shadow-md">
          <label className="flex cursor-pointer items-center justify-between gap-3 py-1 text-xs">
            Log scale (y)
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-primary"
              checked={settings.yLog}
              onChange={(e) => update({ yLog: e.target.checked })}
            />
          </label>
          <label className="flex flex-col gap-1 py-1 text-xs">
            <span className="flex items-center justify-between">
              Smoothing (EMA)
              <span className="font-mono text-[10px] text-muted-foreground">
                {settings.smooth === 0 ? "off" : settings.smooth.toFixed(2)}
              </span>
            </span>
            <input
              type="range"
              min={0}
              max={0.95}
              step={0.05}
              value={settings.smooth}
              onChange={(e) => update({ smooth: Number(e.target.value) })}
              className="accent-primary"
            />
          </label>
        </div>
      ) : null}

      {open === "menu" ? (
        <div className="absolute right-2 top-9 z-20 w-60 rounded-lg border bg-popover p-1 shadow-md">
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
            onClick={() => {
              void navigator.clipboard.writeText(markup());
              setCopied(true);
              setTimeout(() => {
                setCopied(false);
                setOpen(null);
              }, 900);
            }}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            Copy report markup
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
            onClick={() => {
              const draft = [
                "---",
                `title: ${metric}`,
                `description: ${project} — added from the ${metric} panel.`,
                "---",
                "",
                markup(),
                "",
              ].join("\n");
              try {
                sessionStorage.setItem(REPORT_DRAFT_KEY, draft);
              } catch {
                // storage unavailable — the editor opens with its template
              }
              navigate("/reports/new");
            }}
          >
            <FilePlus2 className="h-3.5 w-3.5" />
            Open in report editor
          </button>
        </div>
      ) : null}

      <MetricChart series={shown} height={height} yLog={settings.yLog} />
    </div>
  );
}
