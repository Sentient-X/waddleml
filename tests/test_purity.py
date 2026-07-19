"""The waddleml dependency budgets, executable.

Two packages ride this repo (see pyproject): the SDK (``waddle/``) must stay
importable on any py3.9+ training node — stdlib + duckdb, with psutil/pynvml
only ever imported behind runtime guards; the platform server
(``waddle_server/``) carries the glued backend budget (fastapi/psycopg/
clickhouse-connect/boto3/duckdb/mcp/httpx + sx-auth/sx-observability).
"""

import ast
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent

SDK_ALLOWED = frozenset({"duckdb", "psutil", "pynvml", "waddle"})
SERVER_ALLOWED = frozenset(
    {
        "fastapi",
        "starlette",
        "uvicorn",
        "pydantic",
        "pydantic_settings",
        "psycopg",
        "psycopg_pool",
        "clickhouse_connect",
        "boto3",
        "botocore",
        "duckdb",
        "httpx",
        "mcp",
        "sx_auth",
        "sx_observability",
        "waddle_server",
    }
)


def _stdlib() -> frozenset[str]:
    import sys

    return frozenset(sys.stdlib_module_names)


def _imports(tree_root: Path) -> list[tuple[Path, str]]:
    found: list[tuple[Path, str]] = []
    paths = sorted(tree_root.rglob("*.py"))
    assert paths, f"no modules found under {tree_root}"
    for path in paths:
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Import):
                found.extend((path, alias.name.split(".")[0]) for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                found.append((path, node.module.split(".")[0]))
    return found


@pytest.mark.parametrize(
    ("root", "allowed"),
    [(REPO / "waddle", SDK_ALLOWED), (REPO / "waddle_server", SERVER_ALLOWED)],
    ids=["sdk", "server"],
)
def test_imports_stay_within_the_budget(root: Path, allowed: frozenset[str]) -> None:
    budget = allowed | _stdlib()
    violations = [
        f"{path.relative_to(REPO)}: imports {name}"
        for path, name in _imports(root)
        if name not in budget
    ]
    assert not violations, "imports beyond the budget:\n" + "\n".join(violations)
