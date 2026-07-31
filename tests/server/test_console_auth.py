"""The console's half of the auth contract.

A browser can hold neither header, so if these three endpoints do not behave the
Training workspace is either unreachable or ungated — there is no third option.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from sx_auth.credentials import SESSION_COOKIE

from .conftest import FakeMetricStore, requires_dev_postgres

pytestmark = requires_dev_postgres


def test_the_session_cookie_is_a_credential(rig: tuple[TestClient, FakeMetricStore]) -> None:
    """The whole point: a browser presents no header, only this cookie."""
    client, _ = rig
    with client:
        client.cookies.set(SESSION_COOKIE, "key-a-writer")
        me = client.get("/api/auth/me")
        assert me.status_code == 200, me.text
        assert me.json()["role"] == "writer"


def test_an_unknown_session_is_401_not_a_silent_dev_principal(
    rig: tuple[TestClient, FakeMetricStore],
) -> None:
    client, _ = rig
    with client:
        client.cookies.set(SESSION_COOKIE, "no-such-session")
        assert client.get("/api/auth/me").status_code == 401


def test_me_reports_the_tenancy_key_not_the_home_org(
    rig: tuple[TestClient, FakeMetricStore],
) -> None:
    """`key-cross-writer` has org A as its home and a project owned by org B.
    Rows are stamped with the project's org, so that is what the console must
    show — naming the home org would mislabel whose runs are on screen."""
    client, _ = rig
    with client:
        me = client.get("/api/auth/me", headers={"x-api-key": "key-cross-writer"})
        assert me.status_code == 200, me.text
        assert me.json()["org_slug"] == "org-b"


def test_methods_points_at_the_hosted_login_view_carrying_the_console_origin(
    rig: tuple[TestClient, FakeMetricStore],
) -> None:
    client, _ = rig
    with client:
        reply = client.get("/api/auth/methods", headers={"origin": "http://localhost:5179"})
        assert reply.status_code == 200
        login_url = reply.json()["login_url"]
        assert "/login?next=" in login_url
        assert "localhost%3A5179" in login_url


def test_logout_clears_the_platform_cookie(rig: tuple[TestClient, FakeMetricStore]) -> None:
    """Ending the central session is best effort against a stub that has no
    logout route; clearing the cookie here is not — a shared machine must not
    keep a signed-in tab."""
    client, _ = rig
    with client:
        client.cookies.set(SESSION_COOKIE, "key-a-writer")
        reply = client.post("/api/auth/logout")
        assert reply.status_code == 200
        assert SESSION_COOKIE not in reply.cookies
