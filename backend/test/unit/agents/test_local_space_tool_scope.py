"""本地项目文件工具的作用域与返回路径契约。"""

from types import SimpleNamespace

import pytest

from yuxi.modules.extensions.tools.builtin import local_space

pytestmark = [pytest.mark.asyncio, pytest.mark.unit]


@pytest.fixture
def broker_calls(monkeypatch):
    """把运行时上下文固定到本地项目 demo，并记录发给桌面代理的路径。"""
    scope = {"uid": "user-1", "local_project_root": "demo"}
    monkeypatch.setattr(local_space, "runtime_context_value", lambda _runtime, key: scope.get(key))
    calls = []

    async def fake_call(_uid, endpoint, path, *, content=None):
        calls.append((endpoint, path, content))
        return {
            "folder": "demo",
            "path": path,
            "entries": [{"name": "note.txt", "kind": "file"}],
            "kind": "file",
            "size": 1,
            "text": "hello",
        }

    monkeypatch.setattr(local_space, "_call_broker", fake_call)
    return calls


async def test_local_project_tools_prefix_broker_paths_and_return_relative_paths(broker_calls):
    """四个工具对代理使用项目前缀，对模型仍返回项目内相对路径。"""
    runtime = SimpleNamespace()

    listed = await local_space.list_local_space_files.coroutine(runtime, path="notes")
    read = await local_space.read_local_space_file.coroutine(runtime, path="notes/note.txt")
    written = await local_space.write_local_space_file.coroutine(runtime, path="notes/out.md", content="x")
    deleted = await local_space.delete_local_space_path.coroutine(runtime, path="notes/out.md")

    assert [call[:2] for call in broker_calls] == [
        ("list", "demo/notes"),
        ("read", "demo/notes/note.txt"),
        ("write", "demo/notes/out.md"),
        ("delete", "demo/notes/out.md"),
    ]
    assert broker_calls[2][2] == "x"
    assert listed["path"] == "notes"
    assert read["path"] == "notes/note.txt"
    assert written["path"] == "notes/out.md"
    assert deleted["path"] == "notes/out.md"


async def test_tools_without_local_project_use_global_workspace_path(monkeypatch):
    """普通工作区没有项目前缀，路径保持全局相对路径。"""
    calls = []

    async def fake_call(_uid, endpoint, path, *, content=None):
        calls.append((endpoint, path))
        return {"path": path, "entries": [], "kind": "file"}

    monkeypatch.setattr(local_space, "runtime_context_value", lambda _runtime, key: "user-1" if key == "uid" else None)
    monkeypatch.setattr(local_space, "_call_broker", fake_call)

    result = await local_space.read_local_space_file.coroutine(SimpleNamespace(), path="note.txt")

    assert calls == [("read", "note.txt")]
    assert result["path"] == "note.txt"


@pytest.mark.parametrize("path", ["../secret.txt", "/secret.txt", "C:\\secret.txt"])
async def test_local_project_tools_reject_escape_paths(path, monkeypatch):
    """项目边界外的绝对路径、父目录和 Windows 盘符在发请求前失败。"""
    monkeypatch.setattr(local_space, "runtime_context_value", lambda _runtime, _key: "user-1")
    with pytest.raises(ValueError, match="只允许|非法"):
        await local_space.read_local_space_file.coroutine(SimpleNamespace(), path=path)


async def test_local_project_delete_rejects_empty_path(monkeypatch):
    """删除工具不能把项目根目录当作删除目标。"""
    monkeypatch.setattr(local_space, "runtime_context_value", lambda _runtime, _key: "user-1")
    with pytest.raises(ValueError, match="根目录"):
        await local_space.delete_local_space_path.coroutine(SimpleNamespace(), path="")
