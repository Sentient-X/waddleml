"""Company isolation + role auth over central introspection.

Every request resolves to a :class:`WaddlePrincipal` whose ``org_id`` is the
tenancy key stamped on every Postgres and ClickHouse row — always derived here,
never from the client. Credentials (``Authorization: Bearer``, ``X-API-Key``,
or the platform session cookie ``sx_session``) are introspected against the
central auth service for the ``waddle`` audience; roles narrow to
:class:`WaddleRole` and unknown roles are dropped (fail closed). Authorization
is org-granular (see ``WaddleRole``); the principal's role is the strongest of
its live grants.

Dev is auth-optional: with ``WADDLE_AUTH_REQUIRED=false`` (default) an
unauthenticated request resolves to a fixed dev org admin without touching
sx_authd, so ``make dev`` never depends on the auth service being up.
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from fastapi import HTTPException, Request
from sx_auth.client import AuthClient, AuthUnavailableError

from waddle_server.model import WaddleRole, role_at_least

DEV_ORG_ID = UUID(int=0)
DEV_ORG_SLUG = "dev-local"

SESSION_COOKIE = "sx_session"


@dataclass(frozen=True, slots=True)
class WaddlePrincipal:
    principal_id: UUID | None
    org_id: UUID
    org_slug: str
    subject: str
    role: WaddleRole


def _present_credential(request: Request) -> tuple[str, bool] | None:
    """The presented credential and whether it is a session token. An empty
    header value counts as absent (never introspect the empty string)."""
    auth = request.headers.get("authorization")
    if auth and auth.lower().startswith("bearer ") and auth[7:].strip():
        return auth[7:].strip(), False
    key = request.headers.get("x-api-key")
    if key:
        return key, False
    session = request.cookies.get(SESSION_COOKIE)
    if session:
        return session, True
    return None


async def resolve_principal(
    request: Request, client: AuthClient, *, auth_required: bool
) -> WaddlePrincipal:
    presented = _present_credential(request)
    if presented is None:
        if auth_required:
            raise HTTPException(401, "missing credential")
        return WaddlePrincipal(
            principal_id=None,
            org_id=DEV_ORG_ID,
            org_slug=DEV_ORG_SLUG,
            subject="dev-local",
            role=WaddleRole.ADMIN,
        )
    raw, is_session = presented
    try:
        result = (
            await client.introspect_session(raw)
            if is_session
            else await client.introspect_api_key(raw)
        )
    except AuthUnavailableError as err:
        raise HTTPException(503, "auth service unavailable") from err
    if result is None:
        raise HTTPException(401, "unknown or revoked credential")

    # Grants arrive filtered to the 'waddle' audience; keep the strongest role
    # this app knows and DROP any it does not (fail closed, never widen).
    best: WaddleRole | None = None
    for grant in result.principal.grants:
        try:
            role = WaddleRole(grant.role)
        except ValueError:
            continue
        if best is None or role_at_least(role, best):
            best = role
    if best is None:
        raise HTTPException(403, "no waddle grant on this credential")
    return WaddlePrincipal(
        principal_id=result.principal.id,
        org_id=result.principal.org.id,
        org_slug=result.principal.org.slug,
        subject=result.principal.subject,
        role=best,
    )


def require_role(principal: WaddlePrincipal, required: WaddleRole) -> None:
    if not role_at_least(principal.role, required):
        raise HTTPException(403, f"waddle role {required.value!r} required")
