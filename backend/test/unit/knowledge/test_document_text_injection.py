import pytest

from yuxi.modules.knowledge.manager import KnowledgeBaseManager

pytestmark = pytest.mark.asyncio


class _FakeExecutor:
    def __init__(self, content: str, filename: str = "报告.md") -> None:
        self.content = content
        self.filename = filename

    async def read_file_markdown(self, kb_id: str, file_id: str) -> str:
        assert (kb_id, file_id) == ("kb_1", "file_1")
        return self.content

    async def get_file_basic_info(self, kb_id: str, file_id: str) -> dict:
        assert (kb_id, file_id) == ("kb_1", "file_1")
        return {"meta": {"filename": self.filename}}


def _manager(monkeypatch, executor: _FakeExecutor, work_dir) -> KnowledgeBaseManager:
    manager = KnowledgeBaseManager(str(work_dir))

    async def require_supports_documents(kb_id: str, operation: str) -> None:
        assert (kb_id, operation) == ("kb_1", "read")

    async def get_kb_executor(kb_id: str) -> _FakeExecutor:
        assert kb_id == "kb_1"
        return executor

    monkeypatch.setattr(manager, "_require_kb_supports_documents", require_supports_documents)
    monkeypatch.setattr(manager, "get_kb_executor", get_kb_executor)
    return manager


async def test_read_document_text_returns_full_markdown(monkeypatch, tmp_path):
    manager = _manager(monkeypatch, _FakeExecutor("# 标题\n正文"), tmp_path)

    result = await manager.read_document_text("kb_1", "file_1")

    assert result == {
        "file_id": "file_1",
        "filename": "报告.md",
        "text": "# 标题\n正文",
        "truncated": False,
        "bytes": len("# 标题\n正文".encode()),
    }


async def test_read_document_text_truncates_on_utf8_boundary(monkeypatch, tmp_path):
    manager = _manager(monkeypatch, _FakeExecutor("报告" * 10), tmp_path)

    result = await manager.read_document_text("kb_1", "file_1", max_bytes=7)

    assert result["truncated"] is True
    # 7 字节切在第 3 个汉字中间，丢弃残字节后保留完整字符。
    assert result["text"] == "报告"
    assert result["bytes"] == 6
