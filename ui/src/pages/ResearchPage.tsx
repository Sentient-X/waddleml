import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FlaskConical, GitBranch } from "lucide-react";
import {
  DataTable,
  EmptyState,
  KpiStat,
  PageHeader,
  StatusDot,
  type DataTableColumn,
} from "@sx/ui";

import { waddleApi } from "@/api/client";
import { formatCount, formatDateTime, runDuration } from "@/lib/format";
import {
  researchSessionPath,
  researchSessionsFrom,
  type ResearchSession,
} from "@/lib/research";

export function ResearchPage() {
  const navigate = useNavigate();
  const runsQuery = useQuery({
    queryKey: ["research-runs"],
    queryFn: () => waddleApi.listRuns({ jobType: "autoresearch", limit: 1000 }),
    refetchInterval: 5000,
  });
  const sessions = useMemo(() => researchSessionsFrom(runsQuery.data ?? []), [runsQuery.data]);
  const active = sessions.filter((session) =>
    session.runs.some((run) => run.state === "running"),
  ).length;
  const campaignCount = sessions.reduce((total, session) => total + session.campaigns.length, 0);
  const trialCount = sessions.reduce((total, session) => total + session.runs.length, 0);

  const columns: DataTableColumn<ResearchSession>[] = [
    {
      key: "name",
      header: "Research run",
      sort: (session) => session.name,
      cell: (session) => (
        <div className="flex flex-col">
          <span className="font-medium">{session.name}</span>
          <span className="text-[11px] text-muted-foreground">
            {session.campaigns.length} campaign{session.campaigns.length === 1 ? "" : "s"} ·{" "}
            {session.runs.length} trials
          </span>
        </div>
      ),
    },
    {
      key: "project",
      header: "Project",
      headerClassName: "hidden md:table-cell",
      cellClassName: "hidden md:table-cell",
      sort: (session) => session.project,
      cell: (session) => session.project,
    },
    {
      key: "activity",
      header: "Activity",
      sort: (session) =>
        session.runs.some((run) => run.state === "running") ? "active" : "recorded",
      cell: (session) =>
        session.runs.some((run) => run.state === "running") ? (
          <StatusDot tone="live" label="active" />
        ) : (
          <StatusDot tone="idle" label="recorded" />
        ),
    },
    {
      key: "started",
      header: "Started · UTC",
      headerClassName: "hidden xl:table-cell",
      cellClassName: "hidden xl:table-cell",
      mono: true,
      sort: (session) => session.startedAt,
      cell: (session) => formatDateTime(session.startedAt),
    },
    {
      key: "updated",
      header: "Last evidence · UTC",
      headerClassName: "hidden lg:table-cell",
      cellClassName: "hidden lg:table-cell",
      mono: true,
      sort: (session) => session.updatedAt,
      cell: (session) => formatDateTime(session.updatedAt),
    },
    {
      key: "duration",
      header: "Span",
      headerClassName: "hidden sm:table-cell",
      cellClassName: "hidden sm:table-cell",
      align: "right",
      mono: true,
      sort: (session) =>
        new Date(session.updatedAt).getTime() - new Date(session.startedAt).getTime(),
      cell: (session) => runDuration(session.startedAt, session.updatedAt),
    },
  ];

  if (runsQuery.isError) {
    return (
      <EmptyState
        icon={<FlaskConical />}
        title="Couldn't load research runs"
        hint={(runsQuery.error as Error).message}
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Research runs"
        description="Long-running optimization sessions, with campaigns and candidate trials nested inside."
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiStat label="Research runs" value={formatCount(sessions.length)} />
        <KpiStat label="Active now" value={formatCount(active)} />
        <KpiStat label="Campaigns" value={formatCount(campaignCount)} />
        <KpiStat label="Candidate trials" value={formatCount(trialCount)} />
      </div>

      <DataTable
        columns={columns}
        rows={sessions}
        rowKey={(session) => session.key}
        defaultSort={{ key: "updated", dir: "desc" }}
        loading={runsQuery.isLoading}
        onRowClick={(session) => navigate(researchSessionPath(session))}
        empty={
          <EmptyState
            icon={<GitBranch />}
            title="No research runs yet"
            hint="Start a Waddle autoresearch trial; its session, campaign, and trial tree will appear on the next sync."
          />
        }
      />
    </div>
  );
}
