import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FlaskConical, GitBranch } from "lucide-react";
import { pollWhile } from "@sx/api-client";
import {
  DataTable,
  EmptyState,
  PageHeader,
  StatusDot,
  formatDateTime,
  formatRunDuration,
  type DataTableColumn,
} from "@sx/ui";

import { waddleApi } from "@/api/client";
import type { ResearchSessionSummary } from "@/api/types";
import { formatScalar, researchDecisionTone } from "@/lib/format";
import { researchRecentlyActive, researchSessionPath } from "@/lib/research";

export function ResearchPage() {
  const navigate = useNavigate();
  const sessionsQuery = useQuery({
    queryKey: ["research-sessions"],
    queryFn: () => waddleApi.listResearchSessions(),
    refetchInterval: pollWhile(
      (sessions: ResearchSessionSummary[]) =>
        sessions.some(
          (session) =>
            session.running_count > 0 || researchRecentlyActive(session.updated_at),
        ),
      15_000,
    ),
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
      key: "latest",
      header: "Latest round",
      sort: (session) => session.last_decision ?? "",
      cell: (session) => (
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot tone={researchDecisionTone(session.last_decision)} />
          <div className="min-w-0">
            <div className="truncate">
              {session.last_decision ?? "no outcome recorded"}
              <span className="text-muted-foreground"> · #{session.last_trial_index}</span>
            </div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">
              {session.last_objective_name} ={" "}
              {session.last_objective_value === null
                ? "—"
                : formatScalar(session.last_objective_value)}
            </div>
          </div>
        </div>
      ),
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
      cell: (session) => formatRunDuration(session.started_at, session.updated_at),
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
        description="Optimization sessions — an agent's auto-research campaign is one session, one round per trial. Open one to inspect its trajectory and decisions."
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
            hint="Start an autoresearch trial or an agent campaign; its session appears after sync."
          />
        }
      />
      <p className="text-[10px] text-muted-foreground">
        Sessions with a live trial or activity in the last 10 minutes refresh every 15
        seconds; settled sessions refresh on focus.
      </p>
    </div>
  );
}
