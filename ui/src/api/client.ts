/* The waddle console's endpoint set. The fetch core is `@sx/api-client`'s
   shared `request` (it prefixes /api, carries the cookie session, and narrows
   FastAPI's `detail` — string, typed {code, message}, or pydantic array — to an
   `ApiError` with `.status` and an optional machine `.code`). Every endpoint
   below is a one-liner over it. */

import { body, request } from "@sx/api-client";

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
  ResearchSessionSummary,
  ResearchSessionTrial,
  Run,
  RunDetail,
  RunFacets,
  RunLineage,
  RunState,
  RunType,
} from "./types";

const post = (data: unknown): RequestInit => ({ method: "POST", ...body(data) });
const put = (data: unknown): RequestInit => ({ method: "PUT", ...body(data) });

export interface RunFilter {
  project?: string;
  state?: RunState;
  groupName?: string;
  jobType?: RunType;
  query?: string;
  limit?: number;
  offset?: number;
}

export const waddleApi = {
  listResearchSessions: (limit = 200): Promise<ResearchSessionSummary[]> =>
    request<ResearchSessionSummary[]>(`/v1/research/sessions?limit=${limit}`),
  getResearchSession: (
    project: string,
    sessionName: string,
  ): Promise<ResearchSessionTrial[]> =>
    request<ResearchSessionTrial[]>(
      `/v1/research/sessions/${encodeURIComponent(project)}/${encodeURIComponent(sessionName)}`,
    ),
  listRuns: (filter: RunFilter = {}): Promise<Run[]> => {
    const params = new URLSearchParams();
    if (filter.project) params.set("project", filter.project);
    if (filter.state) params.set("state", filter.state);
    if (filter.groupName) params.set("group_name", filter.groupName);
    if (filter.jobType) params.set("job_type", filter.jobType);
    if (filter.query) params.set("query", filter.query);
    if (filter.limit) params.set("limit", String(filter.limit));
    if (filter.offset) params.set("offset", String(filter.offset));
    const qs = params.toString();
    return request<Run[]>(`/v1/runs${qs ? `?${qs}` : ""}`);
  },
  listRunFacets: (): Promise<RunFacets> => request<RunFacets>("/v1/runs/facets"),
  getRun: (runId: string): Promise<RunDetail> => request<RunDetail>(`/v1/runs/${runId}`),
  listProjects: (): Promise<Project[]> => request<Project[]>("/v1/projects"),
  queryMetrics: (query: MetricsQuery): Promise<MetricSeries[]> =>
    request<MetricSeries[]>("/v1/query/metrics", post(query)),
  queryLatest: (query: MetricsQuery): Promise<LatestMetric[]> =>
    request<LatestMetric[]>("/v1/query/latest", post(query)),
  runLogs: (runId: string, limit = 500): Promise<LogLine[]> =>
    request<LogLine[]>(`/v1/runs/${runId}/logs?limit=${limit}`),
  runLineage: (runId: string): Promise<RunLineage[]> =>
    request<RunLineage[]>(`/v1/runs/${runId}/lineage`),
  getArtifact: (artifactId: string): Promise<ArtifactVersion> =>
    request<ArtifactVersion>(`/v1/artifacts/${artifactId}`),

  // Open datasets door — producer snapshots that become sandbox/report views.
  listDatasets: (): Promise<DatasetInfo[]> => request<DatasetInfo[]>("/v1/datasets"),

  // Reports-as-code. Reports are addressed by uuid `id`; `name` is a renameable
  // per-org slug (`listReports(name)` resolves a slug to its summary).
  listReports: (name?: string): Promise<ReportSummary[]> =>
    request<ReportSummary[]>(`/v1/reports${name ? `?name=${encodeURIComponent(name)}` : ""}`),
  getReport: (id: string): Promise<Report> => request<Report>(`/v1/reports/${id}`),
  createReport: (name: string, reportBody: string): Promise<Report> =>
    request<Report>("/v1/reports", post({ name, body: reportBody })),
  updateReport: (id: string, reportBody: string, name?: string): Promise<Report> =>
    request<Report>(
      `/v1/reports/${id}`,
      put(name ? { body: reportBody, name } : { body: reportBody }),
    ),
  // 204 No Content — the shared core resolves to undefined.
  deleteReport: (id: string): Promise<void> =>
    request<void>(`/v1/reports/${id}`, { method: "DELETE" }),
  listReportVersions: (id: string): Promise<ReportVersion[]> =>
    request<ReportVersion[]>(`/v1/reports/${id}/versions`),
  getReportVersion: (id: string, version: number): Promise<ReportVersionDetail> =>
    request<ReportVersionDetail>(`/v1/reports/${id}/versions/${version}`),
  renderReport: (
    id: string,
    params: Record<string, string> = {},
    maxRows = 1000,
  ): Promise<RenderReport> =>
    request<RenderReport>(`/v1/reports/${id}/render`, post({ params, max_rows: maxRows })),
  previewReport: (
    reportBody: string,
    params: Record<string, string> = {},
    maxRows = 1000,
  ): Promise<RenderReport> =>
    request<RenderReport>(
      "/v1/reports/preview",
      post({ body: reportBody, params, max_rows: maxRows }),
    ),
};
