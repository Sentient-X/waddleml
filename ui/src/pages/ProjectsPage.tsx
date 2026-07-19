import { useQuery } from "@tanstack/react-query";
import { Table2 } from "lucide-react";
import { DataTable, EmptyState, PageHeader, type DataTableColumn } from "@sx/ui";

import { waddleApi } from "@/api/client";
import type { Project } from "@/api/types";
import { formatDateTime } from "@/lib/format";

export function ProjectsPage() {
  const projectsQuery = useQuery({ queryKey: ["projects"], queryFn: () => waddleApi.listProjects() });

  const columns: DataTableColumn<Project>[] = [
    { key: "name", header: "Project", sort: (p) => p.name, cell: (p) => p.name },
    {
      key: "created",
      header: "Created · UTC",
      mono: true,
      sort: (p) => p.created_at,
      cell: (p) => formatDateTime(p.created_at),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Projects" description="Every project your org has reported runs under." />
      {projectsQuery.isError ? (
        <EmptyState
          icon={<Table2 />}
          title="Couldn't load projects"
          hint={(projectsQuery.error as Error).message}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={projectsQuery.data ?? []}
          rowKey={(p) => p.name}
          defaultSort={{ key: "created", dir: "desc" }}
          loading={projectsQuery.isLoading}
          empty={<EmptyState icon={<Table2 />} title="No projects yet" />}
        />
      )}
    </div>
  );
}
