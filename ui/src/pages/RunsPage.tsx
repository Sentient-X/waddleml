import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Waypoints } from "lucide-react";
import {
  Button,
  DataTable,
  EmptyState,
  Input,
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
import type { Run, RunState, RunType } from "@/api/types";
import { formatDateTime, runDuration, runStateTone } from "@/lib/format";

const STATES: readonly RunState[] = ["running", "completed", "failed", "aborted"];
const ALL = "all";
const PAGE_SIZE = 50;

export function RunsPage() {
  const navigate = useNavigate();
  const [project, setProject] = useState<string>(ALL);
  const [state, setState] = useState<string>(ALL);
  const [runType, setRunType] = useState<string>(ALL);
  const [group, setGroup] = useState<string>(ALL);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => setPage(0), [project, state, runType, group, query]);

  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: () => waddleApi.listProjects(),
  });
  const facetsQuery = useQuery({
    queryKey: ["run-facets"],
    queryFn: () => waddleApi.listRunFacets(),
  });
  const runsQuery = useQuery({
    queryKey: ["runs", project, state, runType, group, query, page],
    queryFn: () =>
      waddleApi.listRuns({
        project: project === ALL ? undefined : project,
        state: state === ALL ? undefined : (state as RunState),
        jobType: runType === ALL ? undefined : (runType as RunType),
        groupName: group === ALL ? undefined : group,
        query: query || undefined,
        limit: PAGE_SIZE + 1,
        offset: page * PAGE_SIZE,
      }),
    refetchInterval: (request) =>
      request.state.data?.some((run) => run.state === "running") ? 5_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  const received = runsQuery.data ?? [];
  const rows = received.slice(0, PAGE_SIZE);
  const hasNext = received.length > PAGE_SIZE;
  const firstRow = rows.length > 0 ? page * PAGE_SIZE + 1 : 0;
  const lastRow = page * PAGE_SIZE + rows.length;

  const columns: DataTableColumn<Run>[] = [
    {
      key: "name",
      header: "Run",
      sort: (run) => run.display_name ?? run.name,
      cell: (run) => (
        <div className="flex flex-col">
          <span className="font-medium">{run.display_name ?? run.name}</span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {run.run_id.slice(0, 12)}
          </span>
        </div>
      ),
    },
    { key: "project", header: "Project", sort: (run) => run.project, cell: (run) => run.project },
    {
      key: "type",
      header: "Type",
      sort: (run) => run.job_type,
      cell: (run) => run.job_type ?? <span className="text-muted-foreground">untyped</span>,
    },
    {
      key: "group",
      header: "Group",
      sort: (run) => run.group_name,
      cell: (run) => run.group_name ?? <span className="text-muted-foreground">—</span>,
    },
    {
      key: "state",
      header: "State",
      sort: (run) => run.state,
      cell: (run) => <StatusDot tone={runStateTone(run.state)} label={run.state} />,
    },
    {
      key: "started",
      header: "Started · UTC",
      mono: true,
      sort: (run) => run.started_at,
      cell: (run) => formatDateTime(run.started_at),
    },
    {
      key: "duration",
      header: "Duration",
      align: "right",
      mono: true,
      sort: (run) =>
        new Date(run.finished_at ?? Date.now()).getTime() - new Date(run.started_at).getTime(),
      cell: (run) => runDuration(run.started_at, run.finished_at),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Runs"
        description="Find training, evaluation, benchmark, data, and research work across projects."
      />

      <section aria-label="Run filters" className="grid gap-2 border-y py-3 md:grid-cols-6">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search run name or id…"
          className="h-8 text-xs md:col-span-2"
        />
        <Select value={runType} onValueChange={setRunType}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All types</SelectItem>
            {(facetsQuery.data?.run_types ?? []).map((value) => (
              <SelectItem key={value} value={value}>{value}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={state} onValueChange={setState}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="State" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All states</SelectItem>
            {STATES.map((value) => (
              <SelectItem key={value} value={value}>{value}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={project} onValueChange={setProject}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Project" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All projects</SelectItem>
            {(projectsQuery.data ?? []).map((value) => (
              <SelectItem key={value.name} value={value.name}>{value.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={group} onValueChange={setGroup}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Group" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All groups</SelectItem>
            {(facetsQuery.data?.groups ?? []).map((value) => (
              <SelectItem key={value} value={value}>{value}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </section>

      {runsQuery.isError ? (
        <EmptyState
          icon={<Waypoints />}
          title="Couldn't load runs"
          hint={(runsQuery.error as Error).message}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(run) => run.run_id}
          defaultSort={{ key: "started", dir: "desc" }}
          loading={runsQuery.isLoading}
          dense
          onRowClick={(run) => navigate(`/runs/${run.run_id}`)}
          empty={
            <EmptyState
              icon={<Waypoints />}
              title="No matching runs"
              hint="Change a filter or start a typed Waddle run."
            />
          }
        />
      )}

      <footer className="flex items-center justify-between border-t pt-3 text-xs text-muted-foreground">
        <span>{rows.length > 0 ? `${firstRow}–${lastRow}` : "No rows"} · page {page + 1}</span>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2"
            disabled={page === 0 || runsQuery.isFetching}
            onClick={() => setPage((value) => Math.max(0, value - 1))}
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2"
            disabled={!hasNext || runsQuery.isFetching}
            onClick={() => setPage((value) => value + 1)}
          >
            Next <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </footer>
    </div>
  );
}
