"""Dump the FastAPI OpenAPI schema without starting the app lifespan (the
codegen mesh's per-app dump script)."""

from __future__ import annotations

import json
import sys

from waddle_server.server.app import build_app


def main() -> None:
    app = build_app()
    json.dump(app.openapi(), sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
