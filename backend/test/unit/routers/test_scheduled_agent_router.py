from __future__ import annotations

import importlib
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from yuxi.api.dependencies.auth import get_db, get_required_user

router_module = importlib.import_module("yuxi.api.routers.schedules")


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(router_module.scheduled_agents, prefix="/api")

    async def fake_db():
        return object()

    async def fake_user():
        return SimpleNamespace(uid="user-1", role="user")

    app.dependency_overrides[get_db] = fake_db
    app.dependency_overrides[get_required_user] = fake_user
    return TestClient(app)


def test_scheduled_task_api_uses_proposal_paths_and_forbids_unknown_fields(monkeypatch):
    async def fake_create_scheduled_job(*, data, **_kwargs):
        return data

    monkeypatch.setattr(router_module, "create_scheduled_job", fake_create_scheduled_job)
    response = _client().post(
        "/api/scheduled-tasks",
        json={
            "request_id": "create-request-1",
            "name": "Daily",
            "project_id": "project-1",
            "agent_slug": "chatbot",
            "prompt": "hello",
            "cron_expression": "0 9 * * *",
            "timezone": "Asia/Shanghai",
            "model_spec": "provider:model",
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["project_id"] == "project-1"
    assert response.json()["tool_approval_mode"] == "default"
    assert _client().get("/api/scheduled-agents").status_code == 404

    invalid = _client().post(
        "/api/scheduled-tasks",
        json={
            "request_id": "create-request-2",
            "name": "Daily",
            "project_id": "project-1",
            "agent_slug": "chatbot",
            "prompt": "hello",
            "cron_expression": "0 9 * * *",
            "timezone": "UTC",
            "unknown": True,
        },
    )
    assert invalid.status_code == 422


def test_run_now_and_delete_keep_owner_scope(monkeypatch):
    calls = []

    async def fake_run_now(*, job_id, request_id, user, **_kwargs):
        calls.append(("run-now", job_id, request_id, user.uid))
        return {"id": "execution-1", "thread_id": "thread-1"}

    async def fake_delete(*, job_id, user, **_kwargs):
        calls.append(("delete", job_id, user.uid))
        return True

    monkeypatch.setattr(router_module, "run_scheduled_job_now", fake_run_now)
    monkeypatch.setattr(router_module, "delete_scheduled_job", fake_delete)
    client = _client()

    assert (
        client.post(
            "/api/scheduled-tasks/job-1/run-now",
            json={"request_id": "manual-request-1"},
        ).json()["thread_id"]
        == "thread-1"
    )
    assert client.delete("/api/scheduled-tasks/job-1").json()["deleted"] is True
    assert calls == [
        ("run-now", "job-1", "manual-request-1", "user-1"),
        ("delete", "job-1", "user-1"),
    ]


def test_update_rejects_explicit_null_enabled(monkeypatch):
    async def forbidden_update(**_kwargs):
        raise AssertionError("无效 enabled 不应进入 service")

    monkeypatch.setattr(router_module, "update_scheduled_job", forbidden_update)

    response = _client().patch("/api/scheduled-tasks/job-1", json={"enabled": None})

    assert response.status_code == 422


def test_one_shot_schedule_requires_run_at_and_rejects_cron(monkeypatch):
    async def fake_create_scheduled_job(*, data, **_kwargs):
        return data

    monkeypatch.setattr(router_module, "create_scheduled_job", fake_create_scheduled_job)
    base = {
        "request_id": "create-request-once",
        "name": "One shot",
        "project_id": "project-1",
        "agent_slug": "chatbot",
        "prompt": "hello",
        "timezone": "UTC",
    }
    client = _client()

    accepted = client.post(
        "/api/scheduled-tasks",
        json={**base, "schedule_kind": "once", "run_at": "2026-10-30T09:00:00Z"},
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["run_at"] == "2026-10-30T09:00:00Z"
    assert accepted.json()["cron_expression"] is None

    missing_run_at = client.post(
        "/api/scheduled-tasks", json={**base, "schedule_kind": "once"}
    )
    assert missing_run_at.status_code == 422

    mixed = client.post(
        "/api/scheduled-tasks",
        json={
            **base,
            "schedule_kind": "once",
            "run_at": "2026-10-30T09:00:00Z",
            "cron_expression": "0 9 * * *",
        },
    )
    assert mixed.status_code == 422

    cron_with_run_at = client.post(
        "/api/scheduled-tasks",
        json={**base, "cron_expression": "0 9 * * *", "run_at": "2026-10-30T09:00:00Z"},
    )
    assert cron_with_run_at.status_code == 422


def test_cron_schedule_defaults_to_cron_kind(monkeypatch):
    async def fake_create_scheduled_job(*, data, **_kwargs):
        return data

    monkeypatch.setattr(router_module, "create_scheduled_job", fake_create_scheduled_job)

    response = _client().post(
        "/api/scheduled-tasks",
        json={
            "request_id": "create-request-cron",
            "name": "Daily",
            "project_id": "project-1",
            "agent_slug": "chatbot",
            "prompt": "hello",
            "cron_expression": "0 9 * * *",
            "timezone": "UTC",
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["schedule_kind"] == "cron"
