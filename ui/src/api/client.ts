/* The waddle console's fetch core. Every call hits the backend under /api
   (Vite proxies to :8400 in dev; the backend serves the built SPA in prod).
   The session rides the cookie, so requests use credentials: "include".

   The backend's stable error envelope is FastAPI's `detail`, carrying either a
   typed {code, message} (SqlSandboxError, quota, limits…), a plain string, or
   pydantic's validation array. WaddleApiError narrows all three to a message
   plus an optional machine `code` so callers (the SQL page) can show both. */

import type {
  ArtifactVersion,
  DatasetInfo,
  LatestMetric,
  LogLine,
  MetricSeries,
  MetricsQuery,
  Project,
  RenderReport,
  Report,
  ReportSummary,
  ReportVersion,
  ReportVersionDetail,
  Run,
  RunDetail,
  RunLineage,
  RunState,
} from "./types";

export class WaddleApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string | null = null,
  ) {
    super(message);
    this.name = "WaddleApiError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractError(status: number, statusText: string, bodyText: string): WaddleApiError {
  if (bodyText) {
    try {
      const body: unknown = JSON.parse(bodyText);
      if (isRecord(body) && "detail" in body) {
        const detail = body.detail;
        if (isRecord(detail) && typeof detail.message === "string") {
          const code = typeof detail.code === "string" ? detail.code : null;
          return new WaddleApiError(status, detail.message, code);
        }
        if (typeof detail === "string") return new WaddleApiError(status, detail);
        return new WaddleApiError(status, JSON.stringify(detail));
      }
    } catch {
      return new WaddleApiError(status, bodyText);
    }
    return new WaddleApiError(status, bodyText);
  }
  return new WaddleApiError(status, statusText || `Request failed (${status})`);
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    cache: "no-store",
    headers: { Accept: "application/json", ...init?.headers },
  });
  const bodyText = await response.text();
  if (!response.ok) throw extractError(response.status, response.statusText, bodyText);
  return (bodyText ? JSON.parse(bodyText) : null) as T;
}

function getJson<T>(path: string): Promise<T> {
  return requestJson<T>(path);
}

function postJson<T>(path: string, body: unknown): Promise<T> {
  return requestJson<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function putJson<T>(path: string, body: unknown): Promise<T> {
  return requestJson<T>(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function del(path: string): Promise<null> {
  return requestJson<null>(path, { method: "DELETE" });
}

export interface RunFilter {
  project?: string;
  state?: RunState;
  limit?: number;
}

export const waddleApi = {
  listRuns: (filter: RunFilter = {}): Promise<Run[]> => {
    const params = new URLSearchParams();
    if (filter.project) params.set("project", filter.project);
    if (filter.state) params.set("state", filter.state);
    if (filter.limit) params.set("limit", String(filter.limit));
    const qs = params.toString();
    return getJson<Run[]>(`/v1/runs${qs ? `?${qs}` : ""}`);
  },
  getRun: (runId: string): Promise<RunDetail> => getJson<RunDetail>(`/v1/runs/${runId}`),
  listProjects: (): Promise<Project[]> => getJson<Project[]>("/v1/projects"),
  queryMetrics: (query: MetricsQuery): Promise<MetricSeries[]> =>
    postJson<MetricSeries[]>("/v1/query/metrics", query),
  queryLatest: (query: MetricsQuery): Promise<LatestMetric[]> =>
    postJson<LatestMetric[]>("/v1/query/latest", query),
  runLogs: (runId: string, limit = 500): Promise<LogLine[]> =>
    getJson<LogLine[]>(`/v1/runs/${runId}/logs?limit=${limit}`),
  runLineage: (runId: string): Promise<RunLineage[]> =>
    getJson<RunLineage[]>(`/v1/runs/${runId}/lineage`),
  getArtifact: (artifactId: string): Promise<ArtifactVersion> =>
    getJson<ArtifactVersion>(`/v1/artifacts/${artifactId}`),

  // Open datasets door — producer snapshots that become sandbox/report views.
  listDatasets: (): Promise<DatasetInfo[]> => getJson<DatasetInfo[]>("/v1/datasets"),

  // Reports-as-code. Reports are addressed by uuid `id`; `name` is a renameable
  // per-org slug (`listReports(name)` resolves a slug to its summary).
  listReports: (name?: string): Promise<ReportSummary[]> =>
    getJson<ReportSummary[]>(`/v1/reports${name ? `?name=${encodeURIComponent(name)}` : ""}`),
  getReport: (id: string): Promise<Report> => getJson<Report>(`/v1/reports/${id}`),
  createReport: (name: string, body: string): Promise<Report> =>
    postJson<Report>("/v1/reports", { name, body }),
  updateReport: (id: string, body: string, name?: string): Promise<Report> =>
    putJson<Report>(`/v1/reports/${id}`, name ? { body, name } : { body }),
  deleteReport: (id: string): Promise<null> => del(`/v1/reports/${id}`),
  listReportVersions: (id: string): Promise<ReportVersion[]> =>
    getJson<ReportVersion[]>(`/v1/reports/${id}/versions`),
  getReportVersion: (id: string, version: number): Promise<ReportVersionDetail> =>
    getJson<ReportVersionDetail>(`/v1/reports/${id}/versions/${version}`),
  renderReport: (
    id: string,
    params: Record<string, string> = {},
    maxRows = 1000,
  ): Promise<RenderReport> =>
    postJson<RenderReport>(`/v1/reports/${id}/render`, { params, max_rows: maxRows }),
  previewReport: (
    body: string,
    params: Record<string, string> = {},
    maxRows = 1000,
  ): Promise<RenderReport> =>
    postJson<RenderReport>("/v1/reports/preview", { body, params, max_rows: maxRows }),
};
