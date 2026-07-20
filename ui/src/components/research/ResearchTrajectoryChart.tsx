import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, cn } from "@sx/ui";

import { formatScalar } from "@/lib/format";
import {
  researchVerdictLabel,
  type ResearchCampaign,
  type ResearchMetric,
  type ResearchMetricPoint,
  type ResearchRun,
} from "@/lib/research";

const WIDTH_PER_ATTEMPT = 12;
const MIN_WIDTH = 680;
const HEIGHT = 292;
const MARGIN = { top: 24, right: 18, bottom: 38, left: 64 } as const;

function numericTicks(minimum: number, maximum: number): number[] {
  const span = maximum - minimum || 1;
  return Array.from({ length: 5 }, (_, index) => minimum + (span * index) / 4);
}

function ordinalTicks(minimum: number, maximum: number): number[] {
  if (minimum === maximum) return [minimum];
  const interval = Math.max(1, Math.ceil((maximum - minimum) / 7));
  const values: number[] = [];
  for (let value = minimum; value <= maximum; value += interval) values.push(value);
  if (values.at(-1) !== maximum) values.push(maximum);
  return values;
}

function stepPath(points: readonly { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  return points
    .slice(1)
    .reduce(
      (path, point) => `${path} H ${point.x.toFixed(2)} V ${point.y.toFixed(2)}`,
      `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`,
    );
}

function shortLabel(value: string): string {
  return value.length <= 27 ? value : `${value.slice(0, 26)}…`;
}

function changeLabel(point: ResearchMetricPoint, zeroBaseline: boolean): string {
  const prefix = point.baselineChange > 0 ? "+" : "";
  return `${prefix}${point.baselineChange.toFixed(2)}${zeroBaseline ? " pp" : "%"}`;
}

export function ResearchTrajectoryChart({
  metric,
  selectedRunId,
  onSelect,
}: {
  metric: ResearchMetric;
  selectedRunId: string;
  onSelect: (run: ResearchRun, campaign: ResearchCampaign) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = () => setContainerWidth(container.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const points = metric.points;
  const firstOrdinal = points[0]?.sessionOrdinal ?? 0;
  const lastOrdinal = points.at(-1)?.sessionOrdinal ?? firstOrdinal;
  const width = Math.max(
    MIN_WIDTH,
    containerWidth,
    (lastOrdinal - firstOrdinal + 1) * WIDTH_PER_ATTEMPT + MARGIN.left + MARGIN.right,
  );
  const plotWidth = width - MARGIN.left - MARGIN.right;
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const values = points.flatMap((point) => [point.rawValue, point.incumbentValue]);
  const rawMinimum = Math.min(...values);
  const rawMaximum = Math.max(...values);
  const padding = Math.max(Math.abs(rawMaximum) * 0.02, (rawMaximum - rawMinimum) * 0.1, 0.01);
  const minimum = rawMinimum - padding;
  const maximum = rawMaximum + padding;
  const x = (ordinal: number) =>
    MARGIN.left +
    (firstOrdinal === lastOrdinal
      ? plotWidth / 2
      : ((ordinal - firstOrdinal) / (lastOrdinal - firstOrdinal)) * plotWidth);
  const y = (value: number) =>
    MARGIN.top + ((maximum - value) / (maximum - minimum)) * plotHeight;
  const yTicks = useMemo(() => numericTicks(minimum, maximum), [minimum, maximum]);
  const xTicks = useMemo(
    () => ordinalTicks(firstOrdinal, lastOrdinal),
    [firstOrdinal, lastOrdinal],
  );
  const incumbentPath = stepPath(
    points.map((point) => ({ x: x(point.sessionOrdinal), y: y(point.incumbentValue) })),
  );
  const improvements = points.filter((point) => point.movedIncumbent);
  let lastLabelX = Number.NEGATIVE_INFINITY;
  const labeledImprovements = improvements.slice(1).filter((point) => {
    const position = x(point.sessionOrdinal);
    if (position - lastLabelX < 86) return false;
    lastLabelX = position;
    return true;
  });
  const selectedPoint = points.find((point) => point.run.run_id === selectedRunId) ?? null;

  return (
    <div>
      <div ref={containerRef} className="overflow-x-auto">
        <svg
          role="img"
          aria-label={`${metric.objectiveName}: all evaluated attempts and the running best`}
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          className="block max-w-none"
        >
          {yTicks.map((tick) => (
            <g key={tick}>
              <line
                x1={MARGIN.left}
                x2={width - MARGIN.right}
                y1={y(tick)}
                y2={y(tick)}
                stroke="currentColor"
                className="text-border/70"
              />
              <text
                x={MARGIN.left - 8}
                y={y(tick) + 4}
                textAnchor="end"
                className="fill-muted-foreground font-mono text-[9px]"
              >
                {formatScalar(tick)}
              </text>
            </g>
          ))}
          {xTicks.map((tick) => (
            <g key={tick}>
              <line
                x1={x(tick)}
                x2={x(tick)}
                y1={MARGIN.top}
                y2={MARGIN.top + plotHeight}
                stroke="currentColor"
                className="text-border/45"
              />
              <text
                x={x(tick)}
                y={HEIGHT - 22}
                textAnchor="middle"
                className="fill-muted-foreground font-mono text-[9px]"
              >
                {tick + 1}
              </text>
            </g>
          ))}

          {points.map((point) => (
            <circle
              key={`attempt-${point.run.run_id}`}
              cx={x(point.sessionOrdinal)}
              cy={y(point.rawValue)}
              r={4}
              className="cursor-pointer fill-slate-500 opacity-70 transition-opacity hover:opacity-100 focus:outline-none dark:fill-slate-300"
              role="button"
              tabIndex={0}
              aria-label={`Attempt ${point.sessionOrdinal + 1}: ${point.run.research.hypothesis}; ${metric.objectiveName} ${formatScalar(point.rawValue)}; ${researchVerdictLabel(point.analysis)}`}
              onClick={() => onSelect(point.run, point.campaign)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(point.run, point.campaign);
                }
              }}
            />
          ))}

          <path
            d={incumbentPath}
            fill="none"
            stroke="#16a34a"
            strokeWidth={2.25}
            strokeLinejoin="round"
          />
          {improvements.map((point) => (
            <circle
              key={`best-${point.run.run_id}`}
              cx={x(point.sessionOrdinal)}
              cy={y(point.incumbentValue)}
              r={4}
              fill="#bbf7d0"
              stroke="#16a34a"
              strokeWidth={1.75}
              className="pointer-events-none"
            />
          ))}
          {labeledImprovements.map((point) => (
            <text
              key={`label-${point.run.run_id}`}
              x={x(point.sessionOrdinal) + 5}
              y={y(point.incumbentValue) - 8}
              transform={`rotate(-24 ${x(point.sessionOrdinal) + 5} ${y(point.incumbentValue) - 8})`}
              className="hidden fill-green-700 text-[7px] dark:fill-green-400 sm:block"
            >
              {shortLabel(point.run.research.hypothesis)}
            </text>
          ))}
          {selectedPoint ? (
            <circle
              cx={x(selectedPoint.sessionOrdinal)}
              cy={y(selectedPoint.rawValue)}
              r={7}
              fill="none"
              stroke="#3b82f6"
              strokeWidth={2}
              className="pointer-events-none"
            />
          ) : null}

          <text
            x={MARGIN.left + plotWidth / 2}
            y={HEIGHT - 9}
            textAnchor="middle"
            className="fill-muted-foreground text-[9px]"
          >
            campaign attempt #
          </text>
          <text
            x={13}
            y={MARGIN.top + plotHeight / 2}
            textAnchor="middle"
            transform={`rotate(-90 13 ${MARGIN.top + plotHeight / 2})`}
            className="fill-muted-foreground text-[9px]"
          >
            {metric.goal === "minimize" ? "lower is better" : "higher is better"}
          </text>
        </svg>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-4 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-slate-500 opacity-70 dark:bg-slate-300" /> all attempts
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 bg-green-600" /> running best
        </span>
        <span>Click a point to pin its decision.</span>
      </div>

      {selectedPoint ? (
        <section
          className={cn(
            "mt-3 grid gap-3 border-t pt-3",
            selectedPoint.analysis.source === "controller"
              ? "lg:grid-cols-[minmax(15rem,0.9fr)_minmax(16rem,1.1fr)]"
              : "lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start",
          )}
        >
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2">
              <Badge variant="outline" className="font-mono text-[9px] uppercase">
                {researchVerdictLabel(selectedPoint.analysis)}
              </Badge>
              <span className="font-mono text-[9px] text-muted-foreground">
                attempt {selectedPoint.sessionOrdinal + 1}
              </span>
            </div>
            <p className="text-sm font-medium leading-snug">{selectedPoint.run.research.hypothesis}</p>
          </div>
          {selectedPoint.analysis.source === "controller" ? (
            <div className="min-w-0 text-xs">
              <p className="leading-relaxed">{selectedPoint.analysis.conclusion}</p>
              {selectedPoint.analysis.failedGates.length > 0 ? (
                <p className="mt-1 truncate text-red-600 dark:text-red-400">
                  Failed: {selectedPoint.analysis.failedGates.join(", ")}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="whitespace-nowrap font-mono text-xs tabular-nums">
              {formatScalar(selectedPoint.rawValue)}
              <span className="ml-2 text-[10px] text-muted-foreground">
                {changeLabel(selectedPoint, metric.zeroBaseline)} vs first
              </span>
            </p>
          )}
        </section>
      ) : null}
    </div>
  );
}
