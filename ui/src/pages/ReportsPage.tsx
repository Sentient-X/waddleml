import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { FileText, Plus } from "lucide-react";
import { Button, DataTable, EmptyState, PageHeader, type DataTableColumn } from "@sx/ui";

import { waddleApi } from "@/api/client";
import type { ReportSummary } from "@/api/types";
import { formatDateTime } from "@/lib/format";

export function ReportsPage() {
  const navigate = useNavigate();
  const reportsQuery = useQuery({ queryKey: ["reports"], queryFn: () => waddleApi.listReports() });

  const columns: DataTableColumn<ReportSummary>[] = [
    {
      key: "name",
      header: "Report",
      sort: (r) => r.title ?? r.name,
      cell: (r) => (
        <div className="flex flex-col">
          <span className="font-medium">{r.title ?? r.name}</span>
          <span className="font-mono text-xs text-muted-foreground">{r.name}</span>
        </div>
      ),
    },
    {
      key: "description",
      header: "Description",
      cell: (r) =>
        r.description ? (
          <span className="text-muted-foreground">{r.description}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "updated",
      header: "Updated · UTC",
      mono: true,
      sort: (r) => r.updated_at,
      cell: (r) => formatDateTime(r.updated_at),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Reports"
        description="Markdown + SQL docs that render live over your org's data — authored by humans or agents (waddle.reports.* MCP)."
        actions={
          <Button asChild size="sm">
            <Link to="/reports/new">
              <Plus className="h-4 w-4" /> New report
            </Link>
          </Button>
        }
      />
      {reportsQuery.isError ? (
        <EmptyState
          icon={<FileText />}
          title="Couldn't load reports"
          hint={(reportsQuery.error as Error).message}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={reportsQuery.data ?? []}
          rowKey={(r) => r.name}
          defaultSort={{ key: "updated", dir: "desc" }}
          loading={reportsQuery.isLoading}
          onRowClick={(r) => navigate(`/reports/${encodeURIComponent(r.name)}`)}
          empty={
            <EmptyState
              icon={<FileText />}
              title="No reports yet"
              hint="A report is a markdown doc with named ```sql fences and component tags, compiled and rendered server-side. Agents author them via the waddle.reports.* MCP tools."
              action={
                <Button asChild variant="outline" size="sm">
                  <Link to="/reports/new">
                    <Plus className="h-4 w-4" /> New report
                  </Link>
                </Button>
              }
            />
          }
        />
      )}
    </div>
  );
}
