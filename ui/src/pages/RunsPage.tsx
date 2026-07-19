import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Waypoints } from "lucide-react";
import {
  DataTable,
  EmptyState,
  Input,
  KpiStat,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusDot,
  type DataTableColumn,
} from "@sx/ui";

import { waddleApi } from "@/api/client";
import type { Run, RunState } from "@/api/types";
import { formatCount, formatDateTime, formatScalar, runDuration, runStateTone } from "@/lib/format";

const STATES: readonly RunState[] = ["running", "completed", "failed", "aborted"];
const ALL = "all";

function lossOf(run: Run): number | null {
  const value = run.summary["loss"] ?? run.summary["train/loss"];
  return typeof value === "number" ? value : null;
}

function isToday(iso: string | null): boolean {
  if (iso === null) return false;
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate()
  );
}

export function RunsPage() {
  const navigate = useNavigate();
  const [project, setProject] = useState<string>(ALL);
  const [state, setState] = useState<string>(ALL);
  const [search, setSearch] = useState("");

  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: () => waddleApi.listProjects(),
  });

  const runsQuery = useQuery({
    queryKey: ["runs", project, state],
    queryFn: () =>
      waddleApi.listRuns({
        project: project === ALL ? undefined : project,
        state: state === ALL ? undefined : (state as RunState),
        limit: 500,
      }),
    refetchInterval: 5000,
  });

  const runs = runsQuery.data ?? [];
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return runs;
    return runs.filter(
      (r) =>
        r.name.toLowerCase().includes(needle) ||
        (r.display_name ?? "").toLowerCase().includes(needle) ||
        r.run_id.includes(needle),
    );
  }, [runs, search]);

  const runningNow = runs.filter((r) => r.state === "running").length;
  const failedToday = runs.filter((r) => r.state === "failed" && isToday(r.finished_at)).length;

  const columns: DataTableColumn<Run>[] = [
    {
      key: "name",
      header: "Run",
      sort: (r) => r.display_name ?? r.name,
      cell: (r) => (
        <div className="flex flex-col">
          <span className="font-medium">{r.display_name ?? r.name}</span>
          <span className="font-mono text-[11px] text-muted-foreground">{r.run_id.slice(0, 12)}</span>
        </div>
      ),
    },
    { key: "project", header: "Project", sort: (r) => r.project, cell: (r) => r.project },
    {
      key: "state",
      header: "State",
      sort: (r) => r.state,
      cell: (r) => <StatusDot tone={runStateTone(r.state)} label={r.state} />,
    },
    {
      key: "started",
      header: "Started · UTC",
      mono: true,
      sort: (r) => r.started_at,
      cell: (r) => formatDateTime(r.started_at),
    },
    {
      key: "duration",
      header: "Duration",
      align: "right",
      mono: true,
      sort: (r) => new Date(r.finished_at ?? Date.now()).getTime() - new Date(r.started_at).getTime(),
      cell: (r) => runDuration(r.started_at, r.finished_at),
    },
    {
      key: "loss",
      header: "Loss",
      align: "right",
      mono: true,
      sort: (r) => lossOf(r),
      cell: (r) => {
        const loss = lossOf(r);
        return loss === null ? <span className="text-muted-foreground">—</span> : formatScalar(loss);
      },
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Runs"
        description="Experiment runs across your org's projects — live from the tracker."
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <KpiStat label="Total runs" value={formatCount(runs.length)} />
        <KpiStat label="Running now" value={formatCount(runningNow)} />
        <KpiStat label="Failed today" value={formatCount(failedToday)} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={project} onValueChange={setProject}>
          <SelectTrigger className="h-9 w-48 text-sm">
            <SelectValue placeholder="Project" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All projects</SelectItem>
            {(projectsQuery.data ?? []).map((p) => (
              <SelectItem key={p.name} value={p.name}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={state} onValueChange={setState}>
          <SelectTrigger className="h-9 w-40 text-sm">
            <SelectValue placeholder="State" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All states</SelectItem>
            {STATES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name or id…"
          className="h-9 w-56 text-sm"
        />
      </div>

      {runsQuery.isError ? (
        <EmptyState
          icon={<Waypoints />}
          title="Couldn't load runs"
          hint={(runsQuery.error as Error).message}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={filtered}
          rowKey={(r) => r.run_id}
          defaultSort={{ key: "started", dir: "desc" }}
          loading={runsQuery.isLoading}
          onRowClick={(r) => navigate(`/runs/${r.run_id}`)}
          empty={
            <EmptyState
              icon={<Waypoints />}
              title="No runs yet"
              hint="Runs appear here as soon as a training job reports to the tracker."
            />
          }
        />
      )}
    </div>
  );
}
