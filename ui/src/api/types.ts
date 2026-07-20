/* Wire types, derived from the generated OpenAPI schema (the pydantic models in
   waddle_server are the single source of truth).

   Regenerate after backend changes:

       pnpm run sync:openapi && pnpm run generate:api

   Every exported name below is derived from schema.gen.ts via indexing, so
   backend drift surfaces as a tsc error here rather than at runtime. */

import type { components } from "./schema.gen";

type schemas = components["schemas"];

// Closed wire vocabularies — the backend StrEnums are the source of truth.
export type RunState = schemas["RunState"];

export type Run = schemas["RunOut"];
export type RunDetail = schemas["RunDetailOut"];
export type ResearchTrial = schemas["ResearchTrial"];
export type ResearchOutcome = schemas["ResearchOutcome"];
export type ResearchDecision = schemas["ResearchDecision"];
export type ResearchSessionSummary = schemas["ResearchSessionSummaryOut"];
export type ResearchSessionTrial = schemas["ResearchSessionTrialOut"];
export type Worker = schemas["WorkerOut"];
export type Project = schemas["ProjectOut"];

export type MetricsQuery = schemas["MetricsQueryIn"];
export type MetricSeries = schemas["MetricSeriesOut"];
export type SeriesPoint = schemas["SeriesPointOut"];
export type LatestMetric = schemas["LatestMetricOut"];

export type LogLine = schemas["LogLineOut"];

export type SqlResult = schemas["SqlResultOut"];
export type ColumnType = schemas["ColumnType"];

// Reports-as-code — org-scoped markdown+SQL docs, addressed by uuid `id`; `name`
// is a renameable per-org slug. Compiled and rendered server-side.
export type ReportSummary = schemas["ReportSummaryOut"];
export type Report = schemas["ReportOut"];
export type CreateReportIn = schemas["CreateReportIn"];
export type UpdateReportIn = schemas["UpdateReportIn"];
export type RenderReportIn = schemas["RenderReportIn"];
export type PreviewReportIn = schemas["PreviewReportIn"];
export type RenderBlock = schemas["RenderBlockOut"];
export type RenderReport = schemas["RenderReportOut"];
export type ReportVersion = schemas["ReportVersionOut"];
export type ReportVersionDetail = schemas["ReportVersionDetailOut"];

// Open datasets door — producer-published tabular snapshots that become sandbox
// and report views; surfaced in the editor's autocomplete as extra view names.
export type DatasetInfo = schemas["DatasetInfoOut"];

export type RunLineage = schemas["RunLineageOut"];
export type ArtifactVersion = schemas["ArtifactVersionOut"];
export type ArtifactFile = schemas["ArtifactFileOut"];
