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
        self.calls.append(('GET', url, params, headers))
        result = self.responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    async def post(self, url, json=None, headers=None):
        self.calls.append(('POST', url, json, headers))
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
    assert [call[1] for call in client.calls] == [
        "http://127.0.0.1:5175/local-files/list",
        "http://host.docker.internal:5175/local-files/list",
    ]
    assert client.calls[1][3] == {"Authorization": f"Bearer {grant.token}"}


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
    expected = {
        "list_local_space_files",
        "read_local_space_file",
        "write_local_space_file",
        "delete_local_space_path",
    }
    assert expected <= set(BASE_TOOL_NAMES)
    assert expected <= names


@pytest.mark.asyncio
async def test_runtime_assembly_exposes_local_space_tools():
    """真实运行时装配必须把两个工作区工具交给所有 Agent。"""
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
    assert {
        "list_local_space_files",
        "read_local_space_file",
        "write_local_space_file",
        "delete_local_space_path",
    } <= {tool.name for tool in tools}


@pytest.mark.asyncio
async def test_broker_write_uses_post_json_without_token_in_body(monkeypatch):
    """写入走 POST JSON，token 只放在 Authorization 头。"""
    grant = LocalBrokerGrant(urls=("http://127.0.0.1:5175",), token="a" * 32, folder_name="docs")
    client = _Client([_Response(200, {"path": "notes/today.md", "size": 5})])

    async def fake_grant(_uid):
        return grant

    monkeypatch.setattr("yuxi.modules.extensions.tools.builtin.local_space.get_local_broker_grant", fake_grant)
    monkeypatch.setattr("yuxi.modules.extensions.tools.builtin.local_space.httpx.AsyncClient", lambda **_kwargs: client)

    assert await _call_broker("1", "write", "notes/today.md", content="hello") == {
        "path": "notes/today.md",
        "size": 5,
    }
    method, url, payload, headers = client.calls[0]
    assert (method, url) == ("POST", "http://127.0.0.1:5175/local-files/write")
    assert payload == {"path": "notes/today.md", "content": "hello"}
    assert headers == {"Authorization": f"Bearer {grant.token}"}
    assert grant.token not in str(payload)


def test_local_write_delete_require_approval():
    """写删本地文件默认进入审批，always_trust 才由调用方显式关闭。"""
    from yuxi.modules.agents.runtime.tool_approval import create_tool_approval_middleware

    middleware = create_tool_approval_middleware("default")
    assert {"write_local_space_file", "delete_local_space_path"} <= set(middleware.interrupt_on)
    assert create_tool_approval_middleware("always_trust") is None


@pytest.mark.asyncio
async def test_write_and_delete_validate_before_network():
    """工具在接触 broker 前拒绝空删除路径和超限写入。"""
    from types import SimpleNamespace

    from yuxi.modules.extensions.tools.builtin.local_space import (
        delete_local_space_path,
        write_local_space_file,
    )

    runtime = SimpleNamespace(context={"uid": "user"})
    with pytest.raises(ValueError, match="不能删除工作区根目录"):
        await delete_local_space_path.ainvoke({"path": "", "runtime": runtime})
    with pytest.raises(ValueError, match="不能超过 1 MiB"):
        await write_local_space_file.ainvoke(
            {"path": "big.txt", "content": "x" * (1024 * 1024 + 1), "runtime": runtime}
        )
