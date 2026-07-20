import { useEffect, useMemo, useRef, useState } from "react";

import { formatScalar } from "@/lib/format";
import type {
  ResearchCampaign,
  ResearchRun,
  ResearchTrajectoryPhase,
} from "@/lib/research";

const WIDTH_PER_POINT = 12;
const MIN_WIDTH = 720;
const HEIGHT = 304;
const MARGIN = { top: 30, right: 18, bottom: 38, left: 58 } as const;

function ticks(minimum: number, maximum: number): number[] {
  const span = maximum - minimum || 1;
  return Array.from({ length: 5 }, (_, index) => minimum + (span * index) / 4);
}

function ordinalTicks(pointCount: number): number[] {
  if (pointCount <= 1) return [0];
  const interval = Math.max(1, Math.ceil((pointCount - 1) / 8));
  const values = Array.from(
    { length: Math.floor((pointCount - 1) / interval) + 1 },
    (_, index) => index * interval,
  );
  if (values.at(-1) !== pointCount - 1) values.push(pointCount - 1);
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
  return value.length <= 28 ? value : `${value.slice(0, 27)}…`;
}

export function ResearchTrajectoryChart({
  phases,
  selectedRunId,
  onSelect,
}: {
  phases: readonly ResearchTrajectoryPhase[];
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
  let acceptedOffset = 0;
  const locatedPoints = phases.flatMap((phase) => {
    const located = phase.points.map((point) => ({
      point,
      phase,
      candidateScore: acceptedOffset + point.improvement,
      incumbentScore: acceptedOffset + point.incumbentImprovement,
    }));
    acceptedOffset += Math.max(0, phase.points.at(-1)?.incumbentImprovement ?? 0);
    return located;
  });
  const points = locatedPoints.map(({ point }) => point);
  const width = Math.max(
    MIN_WIDTH,
    containerWidth,
    points.length * WIDTH_PER_POINT + MARGIN.left + MARGIN.right,
  );
  const plotWidth = width - MARGIN.left - MARGIN.right;
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const values = locatedPoints.flatMap(({ candidateScore, incumbentScore }) => [
    candidateScore,
    incumbentScore,
  ]);
  const rawMinimum = Math.min(0, ...values);
  const rawMaximum = Math.max(0, ...values);
  const padding = Math.max(0.5, (rawMaximum - rawMinimum) * 0.1);
  const minimum = rawMinimum - padding;
  const maximum = rawMaximum + padding;
  const x = (ordinal: number) =>
    MARGIN.left +
    (points.length <= 1 ? plotWidth / 2 : (ordinal / (points.length - 1)) * plotWidth);
  const y = (value: number) =>
    MARGIN.top + ((maximum - value) / (maximum - minimum)) * plotHeight;
  const yTicks = useMemo(() => ticks(minimum, maximum), [minimum, maximum]);
  const xTicks = useMemo(() => ordinalTicks(points.length), [points.length]);
  const incumbentPath = stepPath(
    locatedPoints.map(({ point, incumbentScore }) => ({
      x: x(point.ordinal),
      y: y(incumbentScore),
    })),
  );
  let priorIncumbent = Number.NEGATIVE_INFINITY;
  const acceptedImprovements = locatedPoints.filter(({ incumbentScore }) => {
    const improved = incumbentScore > priorIncumbent + 1e-9;
    priorIncumbent = Math.max(priorIncumbent, incumbentScore);
    return improved;
  });
  let lastLabelX = Number.NEGATIVE_INFINITY;
  const labeledImprovements = acceptedImprovements.slice(1).filter(({ point }) => {
    const position = x(point.ordinal);
    if (position - lastLabelX < 72) return false;
    lastLabelX = position;
    return true;
  });

  return (
    <div>
      <div ref={containerRef} className="overflow-x-auto">
        <svg
          role="img"
          aria-label="All evaluated attempts as faint points and the accepted running best as one staircase"
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
                {tick.toFixed(1)}
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
                className="text-border/50"
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

          {locatedPoints.map(({ point, phase, candidateScore }) => {
            const selected = point.run.run_id === selectedRunId;
            const recorded = point.analysis.source === "controller";
            return (
              <circle
                key={`scatter-${point.run.run_id}`}
                cx={x(point.ordinal)}
                cy={y(candidateScore)}
                r={selected ? 5 : 3}
                fill="#64748b"
                fillOpacity={selected ? 0.72 : 0.2}
                stroke={selected ? "#0f172a" : "transparent"}
                strokeWidth={selected ? 1.5 : 0}
                className="cursor-pointer focus:outline-none"
                role="button"
                tabIndex={0}
                onClick={() => onSelect(point.run, phase.campaign)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(point.run, phase.campaign);
                  }
                }}
              >
                <title>
                  {`P${point.phaseIndex + 1} · trial ${point.run.research.trial_index}\n${phase.campaign.objectiveName}: ${formatScalar(point.rawValue)}\nPhase-relative change: ${point.improvement.toFixed(2)}%\nCumulative progress index: ${candidateScore.toFixed(2)}\nDecision: ${point.analysis.verdict}${recorded ? " (controller)" : " (legacy-derived)"}\n${point.run.research.hypothesis}`}
                </title>
              </circle>
            );
          })}

          <path
            d={incumbentPath}
            fill="none"
            stroke="#16a34a"
            strokeWidth={2}
            strokeLinejoin="round"
          />
          {acceptedImprovements.map(({ point, incumbentScore }) => (
              <circle
                key={`kept-${point.run.run_id}`}
                cx={x(point.ordinal)}
                cy={y(incumbentScore)}
                r={3.5}
                fill="#bbf7d0"
                stroke="#16a34a"
                strokeWidth={1.5}
                className="pointer-events-none"
              />
            ))}

          {labeledImprovements.map(({ point, incumbentScore }) => (
            <text
              key={`label-${point.run.run_id}`}
              x={x(point.ordinal) + 5}
              y={y(incumbentScore) - 7}
              transform={`rotate(-24 ${x(point.ordinal) + 5} ${y(incumbentScore) - 7})`}
              className="hidden fill-green-700 text-[7px] dark:fill-green-400 sm:block"
            >
              {shortLabel(point.run.research.hypothesis)}
            </text>
          ))}

          <text
            x={MARGIN.left + plotWidth / 2}
            y={HEIGHT - 9}
            textAnchor="middle"
            className="fill-muted-foreground text-[9px]"
          >
            attempt #
          </text>
          <text
            x={13}
            y={MARGIN.top + plotHeight / 2}
            textAnchor="middle"
            transform={`rotate(-90 13 ${MARGIN.top + plotHeight / 2})`}
            className="fill-muted-foreground text-[9px]"
          >
            cumulative gain index
          </text>
        </svg>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-4 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-slate-500 opacity-25" /> all attempts
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 bg-green-600" /> accepted running best
        </span>
          <span>Cumulative phase-relative gain index; higher is better. Raw scores remain in trial detail.</span>
      </div>
    </div>
  );
}
