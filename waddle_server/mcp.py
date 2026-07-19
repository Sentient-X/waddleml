"""The ``waddle.*`` MCP surface — experiment-tracking queries for agents.

Run as its own process (the storefront precedent): ``python -m waddle_server.mcp``
(streamable HTTP on :8410 by default). Every tool authenticates the caller's
``X-API-Key`` (env ``WADDLE_API_KEY`` fallback for stdio clients) by calling the
waddle API itself — the MCP process holds no database access of its own, so the
API's org isolation and role checks apply verbatim.
"""

from __future__ import annotations

import os
from typing import Any

import httpx
from mcp.server.fastmcp import Context, FastMCP

mcp = FastMCP(
    "waddle",
    instructions=(
        "The Sentient-X experiment-tracking platform: training runs, live metrics, "
        "logs, and comparisons, scoped to your organization's data."
    ),
    port=int(os.environ.get("WADDLE_MCP_PORT", "8410")),
)

_API_URL = os.environ.get("WADDLE_API_URL", "http://127.0.0.1:8400")


class WaddleToolError(Exception):
    """Raised with agent-readable messages; FastMCP relays them as tool errors."""


def _raw_key(ctx: Context | None) -> str | None:  # type: ignore[type-arg]
    if ctx is not None:
        try:
            request = ctx.request_context.request  # pyright: ignore[reportUnknownMemberType, reportUnknownVariableType]
        except ValueError:  # no active request (stdio client) — fall back to env
            request = None
        if request is not None:
            return request.headers.get("x-api-key")  # pyright: ignore[reportUnknownMemberType, reportUnknownVariableType]
    return os.environ.get("WADDLE_API_KEY")


async def _call(
    ctx: Context | None,  # type: ignore[type-arg]
    method: str,
    path: str,
    *,
    json_body: dict[str, Any] | None = None,
    params: dict[str, Any] | None = None,
) -> Any:
    key = _raw_key(ctx)
    if not key:
        raise WaddleToolError("missing X-API-Key (a waddle-audience key is required)")
    async with httpx.AsyncClient(base_url=_API_URL, timeout=30) as http:
        response = await http.request(
            method, path, json=json_body, params=params, headers={"x-api-key": key}
        )
    if response.status_code >= 400:
        raise WaddleToolError(f"waddle API {response.status_code}: {response.text}")
    return response.json()


@mcp.tool(name="waddle.projects.list")
async def projects_list(ctx: Context | None = None) -> list[dict[str, Any]]:  # type: ignore[type-arg]
    """Your organization's tracking projects."""
    return await _call(ctx, "GET", "/api/v1/projects")


@mcp.tool(name="waddle.runs.list")
async def runs_list(
    project: str | None = None,
    state: str | None = None,
    limit: int = 50,
    ctx: Context | None = None,  # type: ignore[type-arg]
) -> list[dict[str, Any]]:
    """Recent runs (newest first) with config and latest-metric summary.
    state: running | completed | failed | aborted."""
    params: dict[str, Any] = {"limit": limit}
    if project:
        params["project"] = project
    if state:
        params["state"] = state
    return await _call(ctx, "GET", "/api/v1/runs", params=params)


@mcp.tool(name="waddle.runs.get")
async def runs_get(run_id: str, ctx: Context | None = None) -> dict[str, Any]:  # type: ignore[type-arg]
    """One run's full record: config, summary, state, and worker topology."""
    return await _call(ctx, "GET", f"/api/v1/runs/{run_id}")


@mcp.tool(name="waddle.metrics.series")
async def metrics_series(
    run_ids: list[str],
    metric_names: list[str] | None = None,
    step_min: int | None = None,
    step_max: int | None = None,
    max_points: int = 500,
    ctx: Context | None = None,  # type: ignore[type-arg]
) -> list[dict[str, Any]]:
    """Decimated metric series for charting/comparison across runs. Omitting
    metric_names returns every metric the runs logged."""
    return await _call(
        ctx,
        "POST",
        "/api/v1/query/metrics",
        json_body={
            "run_ids": run_ids,
            "metric_names": metric_names or [],
            "step_min": step_min,
            "step_max": step_max,
            "max_points": max_points,
        },
    )


@mcp.tool(name="waddle.metrics.latest")
async def metrics_latest(
    run_ids: list[str], ctx: Context | None = None  # type: ignore[type-arg]
) -> list[dict[str, Any]]:
    """The latest value of every metric for the given runs (KPI view)."""
    return await _call(ctx, "POST", "/api/v1/query/latest", json_body={"run_ids": run_ids})


@mcp.tool(name="waddle.logs.tail")
async def logs_tail(
    run_id: str,
    limit: int = 200,
    ctx: Context | None = None,  # type: ignore[type-arg]
) -> list[dict[str, Any]]:
    """The most recent log lines of a run (oldest-first within the window)."""
    return await _call(ctx, "GET", f"/api/v1/runs/{run_id}/logs", params={"limit": limit})


@mcp.tool(name="waddle.sql")
async def sql(
    query: str,
    max_rows: int = 200,
    ctx: Context | None = None,  # type: ignore[type-arg]
) -> dict[str, Any]:
    """Run arbitrary DuckDB SQL over your organization's tracking data.

    Views available: runs (run_id, project, name, state, group_name, job_type,
    config, summary, commit_sha, created_at, started_at, finished_at), metrics
    (run_id, metric_name, step, ts, value, rank, node_id, attempt), logs
    (run_id, ts, level, source, message). Full DuckDB SQL — joins, windows,
    PIVOT, regressions — sandboxed to your org's data only. metrics/logs cover
    what the hourly compaction has exported; use waddle.metrics.series for
    to-the-second freshness."""
    return await _call(
        ctx, "POST", "/api/v1/query/sql", json_body={"sql": query, "max_rows": max_rows}
    )


@mcp.tool(name="waddle.artifacts.get")
async def artifacts_get(artifact_id: str, ctx: Context | None = None) -> dict[str, Any]:  # type: ignore[type-arg]
    """One artifact version: files with signed download URLs, digest, metadata."""
    return await _call(ctx, "GET", f"/api/v1/artifacts/{artifact_id}")


@mcp.tool(name="waddle.runs.lineage")
async def runs_lineage(run_id: str, ctx: Context | None = None) -> list[dict[str, Any]]:  # type: ignore[type-arg]
    """A run's artifact lineage: inputs consumed and outputs produced."""
    return await _call(ctx, "GET", f"/api/v1/runs/{run_id}/lineage")


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
