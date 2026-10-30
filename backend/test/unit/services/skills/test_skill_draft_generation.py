from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from yuxi.modules.extensions.skills import generation as service
from yuxi.modules.extensions.skills.package import SkillEditConflict

VALID = (
    "---\n"
    "slug: weekly-report\n"
    "name: 周报助手\n"
    "description: 用户要求整理周报时使用\n"
    "---\n\n"
    "# 步骤\n\n1. 读取数据。\n"
)


def test_normalize_strips_thinking_and_outer_fence():
    draft = service.normalize_skill_draft(f"<think>内部推理</think>\n```markdown\n{VALID}```")

    assert draft["slug"] == "weekly-report"
    assert draft["name"] == "周报助手"
    assert draft["content"].startswith("---\n")
    assert draft["content"].endswith("\n")


def test_normalize_rejects_missing_frontmatter_and_dependencies():
    with pytest.raises(ValueError, match="frontmatter"):
        service.normalize_skill_draft("# 只有正文")

    with pytest.raises(ValueError, match="依赖"):
        service.normalize_skill_draft(VALID.replace("---\n\n", "tool_dependencies: [web_search]\n---\n\n", 1))


def test_normalize_rejects_oversized_and_long_description():
    with pytest.raises(ValueError, match="64 KiB"):
        service.normalize_skill_draft(VALID + "x" * (service.MAX_DRAFT_BYTES + 1))

    with pytest.raises(ValueError, match="描述过长"):
        service.normalize_skill_draft(VALID.replace("用户要求整理周报时使用", "长" * (service.MAX_DESCRIPTION_CHARS + 1)))


class _Model:
    def __init__(self, text: str):
        self.text = text

    async def ainvoke(self, _messages):
        return SimpleNamespace(text=self.text)


def _patch_generation(monkeypatch, *, text: str = VALID, existing=None, manageable: bool = True):
    agent = SimpleNamespace(id=1, name="周报智能体")
    monkeypatch.setattr(service.AgentRepository, "get_visible_by_slug", AsyncMock(return_value=agent))
    monkeypatch.setattr(service, "user_can_manage_agent", lambda _user, _agent: manageable)
    monkeypatch.setattr(service.SkillRepository, "get_by_bound_agent_id", AsyncMock(return_value=existing))
    monkeypatch.setattr(service, "system_options", SimpleNamespace(get=AsyncMock(return_value={"fast_model": "fast"})))
    monkeypatch.setattr(service, "load_chat_model", lambda *args, **kwargs: _Model(text))


@pytest.mark.asyncio
async def test_generate_returns_validated_draft(monkeypatch):
    _patch_generation(monkeypatch)

    draft = await service.generate_bound_skill_draft(
        None,
        agent_slug="weekly",
        operator=SimpleNamespace(uid="user"),
        purpose="每周汇总销售数据",
        tools=["web_search", "web_search"],
    )

    assert draft["slug"] == "weekly-report"
    assert draft["description"] == "用户要求整理周报时使用"


@pytest.mark.asyncio
async def test_generate_rejects_unmanaged_or_bound_agent(monkeypatch):
    _patch_generation(monkeypatch, manageable=False)
    monkeypatch.setattr(
        service,
        "load_chat_model",
        lambda *args, **kwargs: pytest.fail("权限校验失败时不得调用模型"),
    )
    with pytest.raises(PermissionError):
        await service.generate_bound_skill_draft(None, agent_slug="weekly", operator=SimpleNamespace(uid="user"), purpose="x")

    _patch_generation(monkeypatch, existing=SimpleNamespace(slug="self-1"))
    monkeypatch.setattr(
        service,
        "load_chat_model",
        lambda *args, **kwargs: pytest.fail("已有绑定时不得调用模型"),
    )
    with pytest.raises(SkillEditConflict):
        await service.generate_bound_skill_draft(None, agent_slug="weekly", operator=SimpleNamespace(uid="user"), purpose="x")


@pytest.mark.asyncio
async def test_generate_wraps_model_failure_and_invalid_output(monkeypatch):
    _patch_generation(monkeypatch, text=VALID)

    class _BrokenModel:
        async def ainvoke(self, _messages):
            raise RuntimeError("model down")

    monkeypatch.setattr(service, "load_chat_model", lambda *args, **kwargs: _BrokenModel())
    with pytest.raises(service.SkillDraftGenerationError, match="生成失败"):
        await service.generate_bound_skill_draft(None, agent_slug="weekly", operator=SimpleNamespace(uid="user"), purpose="x")

    _patch_generation(monkeypatch, text="没有 frontmatter")
    with pytest.raises(service.SkillDraftGenerationError, match="格式不合法"):
        await service.generate_bound_skill_draft(None, agent_slug="weekly", operator=SimpleNamespace(uid="user"), purpose="x")
