import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, Play, Terminal } from "lucide-react";
import {
  Button,
  DataTable,
  EmptyState,
  PageHeader,
  Textarea,
  type DataTableColumn,
} from "@sx/ui";

import { waddleApi, WaddleApiError } from "@/api/client";
import type { SqlResult } from "@/api/types";
import { formatScalar } from "@/lib/format";

const STARTER = "select run_id, name, state, created_at\nfrom runs\norder by created_at desc\nlimit 20";

interface ResultRow {
  i: number;
  cells: unknown[];
}

export function SqlPage() {
  const [sql, setSql] = useState(STARTER);

  const run = useMutation<SqlResult, WaddleApiError, string>({
    mutationFn: (query: string) => waddleApi.querySql(query, 1000),
  });

  const result = run.data;
  const columns: DataTableColumn<ResultRow>[] = (result?.columns ?? []).map((name, i) => ({
    key: `${i}-${name}`,
    header: name,
    mono: true,
    cell: (row) => {
      const value = row.cells[i];
      return value === null || value === undefined ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        formatScalar(value)
      );
    },
  }));
  const rows: ResultRow[] = (result?.rows ?? []).map((cells, i) => ({ i, cells }));

  function submit() {
    if (sql.trim()) run.mutate(sql);
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="SQL"
        description="Read-only DuckDB over your org's runs, metrics, and logs — isolation by construction."
      />

      <div className="flex flex-col gap-2">
        <Textarea
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
          }}
          spellCheck={false}
          rows={7}
          className="font-mono text-xs"
          placeholder="select * from runs limit 10"
        />
        <div className="flex items-center gap-3">
          <Button type="button" size="sm" onClick={submit} disabled={run.isPending || !sql.trim()}>
            <Play className="h-4 w-4" /> {run.isPending ? "Running…" : "Run"}
          </Button>
          <span className="text-xs text-muted-foreground">⌘/Ctrl + Enter to run</span>
          {result ? (
            <span className="ml-auto text-xs text-muted-foreground">
              {result.rows.length} row{result.rows.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
      </div>

      {run.isError ? (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div>
            {run.error.code ? (
              <span className="mr-2 font-mono text-xs uppercase text-destructive">
                {run.error.code}
              </span>
            ) : null}
            <span className="text-destructive">{run.error.message}</span>
          </div>
        </div>
      ) : null}

      {result?.truncated ? (
        <div className="rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
          Result truncated to the row limit — narrow the query or lower the scope for the full set.
        </div>
      ) : null}

      {result ? (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.i}
          stickyHeader
          empty={<EmptyState icon={<Terminal />} title="Query returned no rows" />}
        />
      ) : run.isPending ? (
        <p className="text-sm text-muted-foreground">Running query…</p>
      ) : (
        <EmptyState
          icon={<Terminal />}
          title="Run a query"
          hint="Views: runs, metrics, logs. Results appear here."
        />
      )}
    </div>
  );
}
