import asyncio

from starlette.requests import Request

from waddle_server.mcp import healthz


def test_mcp_health_is_total_and_dependency_free() -> None:
    request = Request(
        {"type": "http", "method": "GET", "path": "/healthz", "headers": []}
    )

    response = asyncio.run(healthz(request))

    assert response.status_code == 200
    assert response.body == b"ok"
