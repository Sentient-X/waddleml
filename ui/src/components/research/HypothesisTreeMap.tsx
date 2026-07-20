import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@sx/ui";

import {
  researchAnalyses,
  type ResearchAnalysis,
  type ResearchCampaign,
  type ResearchRun,
  type ResearchSession,
} from "@/lib/research";

const NODE_WIDTH = 224;
const NODE_HEIGHT = 62;
const COLUMN_GAP = 62;
const ROW_GAP = 18;
const MARGIN = 22;

interface LocatedRun {
  run: ResearchRun;
  campaign: ResearchCampaign;
  phaseIndex: number;
  analysis: ResearchAnalysis;
}

interface TreeNode extends LocatedRun {
  depth: number;
  x: number;
  y: number;
}

interface TreeLayout {
  nodes: TreeNode[];
  width: number;
  height: number;
}

function lines(value: string): [string, string] {
  const words = value.split(/\s+/);
  let first = "";
  let cursor = 0;
  while (cursor < words.length && `${first} ${words[cursor]}`.trim().length <= 33) {
    first = `${first} ${words[cursor]}`.trim();
    cursor += 1;
  }
  const remainder = words.slice(cursor).join(" ");
  const second = remainder.length <= 35 ? remainder : `${remainder.slice(0, 34)}…`;
  return [first || value.slice(0, 33), second];
}

function verdictColor(analysis: ResearchAnalysis): string {
  switch (analysis.verdict) {
    case "kept":
      return "#16a34a";
    case "baseline":
      return "#2563eb";
    case "failed":
      return "#dc2626";
    case "running":
      return "#7c3aed";
    case "discarded":
      return "#64748b";
  }
}

function treeLayout(session: ResearchSession): TreeLayout {
  const located = session.campaigns.flatMap((campaign, phaseIndex) => {
    const analyses = researchAnalyses(campaign);
    return campaign.runs.map((run) => ({
      run,
      campaign,
      phaseIndex,
      analysis:
        analyses.get(run.run_id) ??
        ({
          verdict: "discarded",
          conclusion: "No derived outcome is available.",
          evidence: "No derived outcome is available.",
          failedGates: [],
          baselineImprovement: null,
        } satisfies ResearchAnalysis),
    }));
  });
  const byId = new Map(located.map((item) => [item.run.run_id, item]));
  const children = new Map<string, LocatedRun[]>();
  for (const item of located) {
    const parentId = item.run.research.parent_run_id;
    if (!parentId || !byId.has(parentId) || parentId === item.run.run_id) continue;
    const bucket = children.get(parentId) ?? [];
    bucket.push(item);
    children.set(parentId, bucket);
  }
  const rank = (item: LocatedRun) =>
    item.phaseIndex * 1_000_000 + item.run.research.trial_index * 1_000;
  for (const bucket of children.values()) bucket.sort((a, b) => rank(a) - rank(b));

  const roots = located.filter((item) => {
    const parentId = item.run.research.parent_run_id;
    return !parentId || !byId.has(parentId) || parentId === item.run.run_id;
  });
  roots.sort((a, b) => rank(a) - rank(b));
  const visited = new Set<string>();
  const nodes: TreeNode[] = [];
  let nextLeafY = MARGIN;
  let maximumDepth = 0;

  const visit = (item: LocatedRun, depth: number): number => {
    if (visited.has(item.run.run_id)) return nextLeafY;
    visited.add(item.run.run_id);
    maximumDepth = Math.max(maximumDepth, depth);
    const childItems = (children.get(item.run.run_id) ?? []).filter(
      (child) => !visited.has(child.run.run_id),
    );
    const childCenters = childItems.map((child) => visit(child, depth + 1));
    const center =
      childCenters.length > 0
        ? (childCenters[0] + childCenters[childCenters.length - 1]) / 2
        : nextLeafY + NODE_HEIGHT / 2;
    if (childCenters.length === 0) nextLeafY += NODE_HEIGHT + ROW_GAP;
    nodes.push({
      ...item,
      depth,
      x: MARGIN + depth * (NODE_WIDTH + COLUMN_GAP),
      y: center - NODE_HEIGHT / 2,
    });
    return center;
  };

  for (const root of roots) {
    visit(root, 0);
    nextLeafY += ROW_GAP;
  }
  for (const item of located) {
    if (!visited.has(item.run.run_id)) {
      visit(item, 0);
      nextLeafY += ROW_GAP;
    }
  }
  return {
    nodes,
    width: MARGIN * 2 + (maximumDepth + 1) * NODE_WIDTH + maximumDepth * COLUMN_GAP,
    height: Math.max(360, nextLeafY + MARGIN - ROW_GAP),
  };
}

function edgePath(parent: TreeNode, child: TreeNode): string {
  const startX = parent.x + NODE_WIDTH;
  const startY = parent.y + NODE_HEIGHT / 2;
  const endX = child.x;
  const endY = child.y + NODE_HEIGHT / 2;
  const bend = Math.max(24, (endX - startX) / 2);
  return `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`;
}

function subjectPath(subject: TreeNode, evaluation: TreeNode): string {
  const startX = subject.x + NODE_WIDTH / 2;
  const startY = subject.y + NODE_HEIGHT;
  const endX = evaluation.x + NODE_WIDTH / 2;
  const endY = evaluation.y;
  const bendY = Math.max(startY, endY) + 24;
  return `M ${startX} ${startY} C ${startX} ${bendY}, ${endX} ${bendY}, ${endX} ${endY}`;
}

export function HypothesisTreeMap({
  session,
  selectedRunId,
  onSelect,
}: {
  session: ResearchSession;
  selectedRunId: string;
  onSelect: (run: ResearchRun, campaign: ResearchCampaign) => void;
}) {
  const layout = useMemo(() => treeLayout(session), [session]);
  const byId = new Map(layout.nodes.map((node) => [node.run.run_id, node]));
  const parentEdges = layout.nodes.flatMap((node) => {
    const parentId = node.run.research.parent_run_id;
    const parent = parentId ? byId.get(parentId) : undefined;
    return parent ? [{ parent, child: node }] : [];
  });
  const subjectEdges = layout.nodes.flatMap((node) => {
    const subjectId = node.run.research.subject_run_id;
    const subject = subjectId ? byId.get(subjectId) : undefined;
    return subject ? [{ subject, evaluation: node }] : [];
  });

  return (
    <Card className="min-w-0">
      <CardHeader className="flex-row items-start justify-between space-y-0 py-3">
        <div>
          <CardTitle className="text-sm">Hypothesis tree</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Solid edges show which idea produced the next hypothesis; dashed blue edges show what
            an evaluation measured.
          </p>
        </div>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {layout.nodes.length} ideas
        </span>
      </CardHeader>
      <CardContent className="p-0">
        <div className="max-h-[44rem] overflow-auto border-t">
          <svg
            role="tree"
            aria-label="Research hypothesis lineage"
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            className="block max-w-none bg-muted/10"
          >
            <defs>
              <marker
                id="evaluation-arrow"
                markerWidth="8"
                markerHeight="8"
                refX="7"
                refY="4"
                orient="auto"
              >
                <path d="M 0 0 L 8 4 L 0 8 z" fill="#2563eb" />
              </marker>
            </defs>
            {parentEdges.map(({ parent, child }) => (
              <path
                key={`parent-${parent.run.run_id}-${child.run.run_id}`}
                d={edgePath(parent, child)}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.25}
                className="text-border"
              />
            ))}
            {subjectEdges.map(({ subject, evaluation }) => (
              <path
                key={`subject-${subject.run.run_id}-${evaluation.run.run_id}`}
                d={subjectPath(subject, evaluation)}
                fill="none"
                stroke="#2563eb"
                strokeDasharray="5 4"
                strokeWidth={1.25}
                markerEnd="url(#evaluation-arrow)"
                opacity={0.75}
              />
            ))}
            {layout.nodes.map((node) => {
              const [firstLine, secondLine] = lines(node.run.research.hypothesis);
              const color = verdictColor(node.analysis);
              const selected = node.run.run_id === selectedRunId;
              return (
                <g
                  key={node.run.run_id}
                  role="treeitem"
                  tabIndex={0}
                  aria-label={`Phase ${node.phaseIndex + 1}, trial ${node.run.research.trial_index}, ${node.analysis.verdict}: ${node.run.research.hypothesis}`}
                  className="cursor-pointer focus:outline-none"
                  onClick={() => onSelect(node.run, node.campaign)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(node.run, node.campaign);
                    }
                  }}
                >
                  <rect
                    x={node.x}
                    y={node.y}
                    width={NODE_WIDTH}
                    height={NODE_HEIGHT}
                    rx={7}
                    fill="hsl(var(--background))"
                    stroke={selected ? "#2563eb" : color}
                    strokeWidth={selected ? 2.5 : 1.25}
                  />
                  <rect
                    x={node.x}
                    y={node.y}
                    width={5}
                    height={NODE_HEIGHT}
                    rx={2.5}
                    fill={color}
                  />
                  <text
                    x={node.x + 14}
                    y={node.y + 17}
                    className="fill-muted-foreground font-mono text-[9px] uppercase"
                  >
                    P{node.phaseIndex + 1} · trial {node.run.research.trial_index} · {node.analysis.verdict}
                  </text>
                  <text x={node.x + 14} y={node.y + 35} className="fill-foreground text-[10px] font-medium">
                    {firstLine}
                  </text>
                  {secondLine ? (
                    <text x={node.x + 14} y={node.y + 50} className="fill-foreground text-[10px]">
                      {secondLine}
                    </text>
                  ) : null}
                  <title>{`${node.analysis.evidence}\n${node.analysis.conclusion}`}</title>
                </g>
              );
            })}
          </svg>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t px-4 py-2 text-[10px] text-muted-foreground">
          <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-blue-600" />baseline</span>
          <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-green-600" />working / kept</span>
          <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-slate-500" />discarded</span>
          <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-red-600" />failed</span>
          <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-violet-600" />running</span>
        </div>
      </CardContent>
    </Card>
  );
}
