import asyncio
import json

from starlette.requests import Request
from sx_service.app import HEALTH_PATH

from waddle_server.mcp import healthz


def test_mcp_health_is_total_and_dependency_free() -> None:
    request = Request(
        {"type": "http", "method": "GET", "path": HEALTH_PATH, "headers": []}
    )

    response = asyncio.run(healthz(request))

    assert response.status_code == 200
    assert json.loads(bytes(response.body)) == {"ok": True}
