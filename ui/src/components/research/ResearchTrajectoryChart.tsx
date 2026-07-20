import { useMemo } from "react";

import { formatScalar } from "@/lib/format";
import type {
  ResearchCampaign,
  ResearchRun,
  ResearchTrajectoryPhase,
} from "@/lib/research";

const WIDTH_PER_POINT = 15;
const MIN_WIDTH = 760;
const HEIGHT = 300;
const MARGIN = { top: 34, right: 24, bottom: 40, left: 58 } as const;

function ticks(minimum: number, maximum: number): number[] {
  const span = maximum - minimum || 1;
  return Array.from({ length: 5 }, (_, index) => minimum + (span * index) / 4);
}

function stepPath(
  points: readonly { x: number; y: number }[],
): string {
  if (points.length === 0) return "";
  return points
    .slice(1)
    .reduce(
      (path, point) => `${path} H ${point.x.toFixed(2)} V ${point.y.toFixed(2)}`,
      `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`,
    );
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
  const pointCount = phases.reduce((total, phase) => total + phase.points.length, 0);
  const width = Math.max(MIN_WIDTH, pointCount * WIDTH_PER_POINT + MARGIN.left + MARGIN.right);
  const plotWidth = width - MARGIN.left - MARGIN.right;
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const values = phases.flatMap((phase) =>
    phase.points.flatMap((point) => [point.improvement, point.incumbentImprovement]),
  );
  const rawMinimum = Math.min(0, ...values);
  const rawMaximum = Math.max(0, ...values);
  const padding = Math.max(1, (rawMaximum - rawMinimum) * 0.12);
  const minimum = rawMinimum - padding;
  const maximum = rawMaximum + padding;
  const x = (ordinal: number) =>
    MARGIN.left + (pointCount <= 1 ? plotWidth / 2 : (ordinal / (pointCount - 1)) * plotWidth);
  const y = (value: number) =>
    MARGIN.top + ((maximum - value) / (maximum - minimum)) * plotHeight;
  const yTicks = useMemo(() => ticks(minimum, maximum), [minimum, maximum]);
  const zeroBaseline = phases.some((phase) => phase.zeroBaseline);
  const phaseLabelInterval = Math.max(1, Math.ceil(phases.length / 18));

  return (
    <div>
      <div className="overflow-x-auto">
        <svg
          role="img"
          aria-label="Direction-adjusted score improvement across every research campaign phase"
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
                className="text-border"
              />
              <text
                x={MARGIN.left - 9}
                y={y(tick) + 4}
                textAnchor="end"
                className="fill-muted-foreground font-mono text-[10px]"
              >
                {tick.toFixed(1)}%
              </text>
            </g>
          ))}
          <line
            x1={MARGIN.left}
            x2={width - MARGIN.right}
            y1={y(0)}
            y2={y(0)}
            stroke="currentColor"
            strokeWidth={1.5}
            className="text-muted-foreground"
          />

          {phases.map((phase, phasePosition) => {
            const first = phase.points[0];
            const last = phase.points[phase.points.length - 1];
            const previous = phases[phasePosition - 1]?.points.at(-1);
            const next = phases[phasePosition + 1]?.points[0];
            const left = previous ? (x(previous.ordinal) + x(first.ordinal)) / 2 : MARGIN.left;
            const right = next ? (x(last.ordinal) + x(next.ordinal)) / 2 : width - MARGIN.right;
            const incumbentPath = stepPath(
              phase.points.map((point) => ({
                x: x(point.ordinal),
                y: y(point.incumbentImprovement),
              })),
            );
            const candidatePath = phase.points
              .map((point, index) =>
                `${index === 0 ? "M" : "L"} ${x(point.ordinal).toFixed(2)} ${y(point.improvement).toFixed(2)}`,
              )
              .join(" ");
            return (
              <g key={phase.campaign.key}>
                <rect
                  x={left}
                  y={MARGIN.top}
                  width={right - left}
                  height={plotHeight}
                  className={phasePosition % 2 === 0 ? "fill-muted/20" : "fill-transparent"}
                />
                <line
                  x1={left}
                  x2={left}
                  y1={MARGIN.top}
                  y2={MARGIN.top + plotHeight}
                  stroke="currentColor"
                  strokeDasharray="3 4"
                  className="text-border"
                />
                {phasePosition === 0 ||
                phasePosition === phases.length - 1 ||
                phasePosition % phaseLabelInterval === 0 ? (
                  <text
                    x={(left + right) / 2}
                    y={20}
                    textAnchor="middle"
                    className="fill-muted-foreground font-mono text-[10px]"
                  >
                    P{phase.phaseIndex + 1}
                  </text>
                ) : null}
                <path d={candidatePath} fill="none" stroke="#2563eb" strokeWidth={1.4} />
                <path d={incumbentPath} fill="none" stroke="#f97316" strokeWidth={1.8} />
                {phase.points.map((point) => (
                  <circle
                    key={point.run.run_id}
                    cx={x(point.ordinal)}
                    cy={y(point.improvement)}
                    r={point.run.run_id === selectedRunId ? 5.5 : 4}
                    fill={point.improvement >= 0 ? "#2563eb" : "#dc2626"}
                    stroke={point.run.run_id === selectedRunId ? "#f8fafc" : "transparent"}
                    strokeWidth={2}
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
                      {`Phase ${phase.phaseIndex + 1} · trial ${point.run.research.trial_index}\n${phase.campaign.objectiveName}: ${formatScalar(point.rawValue)}\nDirection-adjusted improvement: ${point.improvement.toFixed(2)}%\n${point.run.research.hypothesis}`}
                    </title>
                  </circle>
                ))}
              </g>
            );
          })}

          <text
            x={MARGIN.left + plotWidth / 2}
            y={HEIGHT - 10}
            textAnchor="middle"
            className="fill-muted-foreground text-[10px]"
          >
            evaluated candidates in campaign order
          </text>
        </svg>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <div className="flex items-center gap-4">
          <span className="inline-flex shrink-0 items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-[#2563eb]" /> candidate
          </span>
          <span className="inline-flex shrink-0 items-center gap-1.5">
            <span className="h-0.5 w-3 bg-[#f97316]" /> phase incumbent
          </span>
          <span>higher is better; each phase resets to 0%</span>
        </div>
        {zeroBaseline ? <span>* zero baselines use percentage-point delta</span> : null}
      </div>
    </div>
  );
}
