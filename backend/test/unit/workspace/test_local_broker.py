"""桌面本地文件代理授权与 Agent 工具边界测试。"""

import httpx
import pytest

from yuxi.modules.extensions.tools.builtin.local_space import (
    _call_broker,
    _normalize_relative_path,
)
from yuxi.modules.workspace.local_broker import LocalBrokerGrant, normalize_grant


def test_normalizes_only_loopback_broker_urls():
    grant = normalize_grant(
        urls=["http://127.0.0.1:5175", "http://host.docker.internal:5175/"],
        token="a" * 32,
        folder_name="docs",
    )
    assert grant.urls == ("http://127.0.0.1:5175", "http://host.docker.internal:5175")
    assert grant.folder_name == "docs"


@pytest.mark.parametrize(
    "urls",
    [
        ["http://example.com:5175"],
        ["https://127.0.0.1:5175"],
        ["http://127.0.0.1:80"],
        ["http://user:pass@127.0.0.1:5175"],
        ["http://127.0.0.1:5175/api"],
        ["http://127.0.0.1:5175?x=1"],
    ],
)
def test_rejects_non_local_or_ambiguous_broker_urls(urls):
    with pytest.raises(ValueError):
        normalize_grant(urls=urls, token="a" * 32, folder_name="docs")


def test_rejects_weak_tokens_and_empty_folder_names():
    with pytest.raises(ValueError):
        normalize_grant(urls=["http://127.0.0.1:5175"], token="short", folder_name="docs")
    with pytest.raises(ValueError):
        normalize_grant(urls=["http://127.0.0.1:5175"], token="a" * 32, folder_name=" ")


def test_normalizes_agent_paths_and_rejects_traversal():
    assert _normalize_relative_path(" notes/today.md ") == "notes/today.md"
    assert _normalize_relative_path("notes\\today.md") == "notes/today.md"
    for value in ["../secret", "notes/../../secret", "C:/Windows/win.ini", "/notes/today.md"]:
        with pytest.raises(ValueError):
            _normalize_relative_path(value)


class _Response:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


class _Client:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False

    async def get(self, url, params=None, headers=None):
        self.calls.append((url, params, headers))
        result = self.responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


@pytest.mark.asyncio
async def test_broker_call_uses_next_url_and_never_leaks_token(monkeypatch):
    grant = LocalBrokerGrant(
        urls=("http://127.0.0.1:5175", "http://host.docker.internal:5175"),
        token="a" * 32,
        folder_name="docs",
    )
    client = _Client([httpx.ConnectError("refused"), _Response(200, {"entries": []})])

    async def fake_grant(uid):
        assert uid == "1"
        return grant

    monkeypatch.setattr("yuxi.modules.extensions.tools.builtin.local_space.get_local_broker_grant", fake_grant)
    monkeypatch.setattr("yuxi.modules.extensions.tools.builtin.local_space.httpx.AsyncClient", lambda **_kwargs: client)

    assert await _call_broker("1", "list", "notes") == {"entries": []}
    assert [call[0] for call in client.calls] == [
        "http://127.0.0.1:5175/local-files/list",
        "http://host.docker.internal:5175/local-files/list",
    ]
    assert client.calls[1][2] == {"Authorization": f"Bearer {grant.token}"}


@pytest.mark.asyncio
async def test_broker_call_reports_revoked_authorization(monkeypatch):
    grant = LocalBrokerGrant(urls=("http://127.0.0.1:5175",), token="a" * 32, folder_name="docs")

    async def fake_grant(_uid):
        return grant

    monkeypatch.setattr("yuxi.modules.extensions.tools.builtin.local_space.get_local_broker_grant", fake_grant)
    monkeypatch.setattr(
        "yuxi.modules.extensions.tools.builtin.local_space.httpx.AsyncClient",
        lambda **_kwargs: _Client([_Response(401, {})]),
    )

    with pytest.raises(ValueError, match="授权已失效"):
        await _call_broker("1", "read", "notes/today.md")


def test_local_space_tools_are_always_registered():
    """新工具必须进入基础工具集，否则既有 Agent 不会装配。"""
    from yuxi.modules.extensions.tools.builtin import BASE_TOOL_NAMES
    from yuxi.modules.extensions.tools.registry import get_all_tool_instances

    names = {tool.name for tool in get_all_tool_instances()}
    assert {"list_local_space_files", "read_local_space_file"} <= set(BASE_TOOL_NAMES)
    assert {"list_local_space_files", "read_local_space_file"} <= names


@pytest.mark.asyncio
async def test_runtime_assembly_exposes_local_space_tools():
    """真实运行时装配必须把两个个人空间工具交给所有 Agent。"""
    from types import SimpleNamespace

    from yuxi.modules.extensions.tools.runtime import resolve_configured_runtime_tools

    context = SimpleNamespace(
        tools=[],
        mcps=[],
        mcp_tool_servers={},
        mcp_tools={},
        mcp_unavailable={},
        registered_builtin_tool_names=set(),
        skill_runtime_snapshot=None,
    )
    tools = await resolve_configured_runtime_tools(context)
    assert {"list_local_space_files", "read_local_space_file"} <= {tool.name for tool in tools}
