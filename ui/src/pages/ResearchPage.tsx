import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FlaskConical, GitBranch } from "lucide-react";
import {
  DataTable,
  EmptyState,
  PageHeader,
  StatusDot,
  type DataTableColumn,
} from "@sx/ui";

import { waddleApi } from "@/api/client";
import type { ResearchSessionSummary } from "@/api/types";
import { formatDateTime, runDuration } from "@/lib/format";
import { researchSessionPath } from "@/lib/research";

export function ResearchPage() {
  const navigate = useNavigate();
  const sessionsQuery = useQuery({
    queryKey: ["research-sessions"],
    queryFn: () => waddleApi.listResearchSessions(),
    refetchInterval: (query) =>
      query.state.data?.some((session) => session.running_count > 0) ? 15_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  const columns: DataTableColumn<ResearchSessionSummary>[] = [
    {
      key: "name",
      header: "Research run",
      sort: (session) => session.session_name,
      cell: (session) => (
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot tone={session.running_count > 0 ? "live" : "idle"} />
          <div className="min-w-0">
            <div className="truncate font-medium">{session.session_name}</div>
            <div className="truncate text-[11px] text-muted-foreground">{session.project}</div>
          </div>
        </div>
      ),
    },
    {
      key: "progress",
      header: "Work",
      mono: true,
      sort: (session) => session.trial_count,
      cell: (session) =>
        `${session.trial_count} trials · ${session.phase_count} phases${session.running_count > 0 ? ` · ${session.running_count} live` : ""}`,
    },
    {
      key: "updated",
      header: "Updated · UTC",
      headerClassName: "hidden md:table-cell",
      cellClassName: "hidden md:table-cell",
      mono: true,
      sort: (session) => session.updated_at,
      cell: (session) => formatDateTime(session.updated_at),
    },
    {
      key: "duration",
      header: "Span",
      headerClassName: "hidden sm:table-cell",
      cellClassName: "hidden sm:table-cell",
      align: "right",
      mono: true,
      sort: (session) =>
        new Date(session.updated_at).getTime() - new Date(session.started_at).getTime(),
      cell: (session) => runDuration(session.started_at, session.updated_at),
    },
  ];

  if (sessionsQuery.isError) {
    return (
      <EmptyState
        icon={<FlaskConical />}
        title="Couldn't load research runs"
        hint={(sessionsQuery.error as Error).message}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Research"
        description="Optimization sessions. Open one to inspect its trajectory and decisions."
      />
      <DataTable
        columns={columns}
        rows={sessionsQuery.data ?? []}
        rowKey={(session) => `${session.project}:${session.session_name}`}
        defaultSort={{ key: "updated", dir: "desc" }}
        loading={sessionsQuery.isLoading}
        onRowClick={(session) => navigate(researchSessionPath(session))}
        empty={
          <EmptyState
            icon={<GitBranch />}
            title="No research runs yet"
            hint="Start an autoresearch trial; its session appears after sync."
          />
        }
      />
      <p className="text-[10px] text-muted-foreground">
        Active sessions refresh every 15 seconds; completed sessions refresh on focus.
      </p>
    </div>
  );
}
