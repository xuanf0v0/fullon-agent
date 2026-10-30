"""Agent 专属 Skill 的 AI 草稿生成；只返回预览，不落盘。"""

from __future__ import annotations

import asyncio
import json
import re

from sqlalchemy.ext.asyncio import AsyncSession

from yuxi.infrastructure.observability.logging import logger
from yuxi.modules.agents.permissions import user_can_manage_agent
from yuxi.modules.agents.repositories.definitions import AgentRepository
from yuxi.modules.extensions.skills.package import SkillEditConflict, parse_skill_markdown
from yuxi.modules.extensions.skills.repository import SkillRepository
from yuxi.modules.identity.models import User
from yuxi.modules.models.chat import load_chat_model
from yuxi.modules.system.options import system_options

MAX_DRAFT_BYTES = 64 * 1024
MAX_DESCRIPTION_CHARS = 500
MAX_TOOLS = 20
DEPENDENCY_KEYS = ("tool_dependencies", "mcp_dependencies", "skill_dependencies")

SYSTEM_PROMPT = (
    "你是 Yuxi 的 Skill 作者。根据用户提供的用途生成一个可复用的 Agent Skill。"
    "只输出 SKILL.md 的完整 Markdown 文本，不解释、不使用代码围栏包裹整个文件。"
    "文件必须以 YAML frontmatter 开头，且只包含 slug、name、description 三个字段：\n"
    "---\n"
    "slug: <小写连字符标识>\n"
    "name: <展示名>\n"
    "description: <一句话说明何时使用，包含触发词>\n"
    "---\n"
    "正文必须包含：适用场景、执行步骤、工具使用、输出格式、失败与边界处理。"
    "只能引用用户列出的工具；不要虚构工具、路径、URL 或凭据；"
    "不要声明 tool_dependencies、mcp_dependencies、skill_dependencies。"
    "使用用户输入的语言，避免空泛描述，步骤要能让另一个模型直接执行。"
)


class SkillDraftGenerationError(RuntimeError):
    """生成调用或输出校验失败；消息可直接展示给用户。"""


async def generate_bound_skill_draft(
    db: AsyncSession,
    *,
    agent_slug: str,
    operator: User,
    purpose: str,
    triggers: str | None = None,
    inputs_outputs: str | None = None,
    tools: list[str] | None = None,
) -> dict[str, str]:
    """为可管理的 Agent 生成专属 Skill 草稿，返回未保存的 Markdown。"""
    purpose = _normalize_purpose(purpose)
    agent = await AgentRepository(db).get_visible_by_slug(slug=agent_slug, user=operator, for_run=False)
    if agent is None or not user_can_manage_agent(operator, agent):
        raise PermissionError("智能体不存在或无权限管理")
    if await SkillRepository(db).get_by_bound_agent_id(agent.id) is not None:
        raise SkillEditConflict("已存在专属 Skill，请直接编辑；如需重写请先删除")
    return await _generate_draft(
        db,
        operator=operator,
        agent_name=agent.name,
        purpose=purpose,
        triggers=triggers,
        inputs_outputs=inputs_outputs,
        tools=tools,
    )


async def generate_new_skill_draft(
    db: AsyncSession,
    *,
    operator: User,
    agent_name: str,
    purpose: str,
    triggers: str | None = None,
    inputs_outputs: str | None = None,
    tools: list[str] | None = None,
) -> dict[str, str]:
    """为尚未创建的 Agent 生成草稿；调用方负责在创建成功后保存。"""
    agent_name = (agent_name or "").strip()
    if not agent_name:
        raise ValueError("请先填写智能体名称")
    if len(agent_name) > 100:
        raise ValueError("智能体名称过长")
    return await _generate_draft(
        db,
        operator=operator,
        agent_name=agent_name,
        purpose=_normalize_purpose(purpose),
        triggers=triggers,
        inputs_outputs=inputs_outputs,
        tools=tools,
    )


async def _generate_draft(
    db: AsyncSession,
    *,
    operator: User,
    agent_name: str,
    purpose: str,
    triggers: str | None,
    inputs_outputs: str | None,
    tools: list[str] | None,
) -> dict[str, str]:
    """一次有界模型调用；调用方已完成权限与绑定检查。"""
    options = await system_options.get(db)
    model_spec = (options or {}).get("fast_model")
    if not model_spec:
        raise SkillDraftGenerationError("未配置快速模型，无法生成 Skill 草稿")

    payload = {
        "agent_name": agent_name,
        "purpose": purpose,
        "triggers": (triggers or "").strip() or None,
        "inputs_outputs": (inputs_outputs or "").strip() or None,
        "tools": _normalize_tools(tools),
    }
    try:
        model = load_chat_model(model_spec, uid=operator.uid, max_tokens=3000, max_retries=0)
        async with asyncio.timeout(60):
            response = await model.ainvoke(
                [
                    ("system", SYSTEM_PROMPT),
                    ("human", json.dumps(payload, ensure_ascii=False, separators=(",", ":"))),
                ]
            )
    except TimeoutError as exc:
        raise SkillDraftGenerationError("Skill 草稿生成超时，请重试") from exc
    except Exception as exc:
        logger.warning(f"Skill 草稿生成失败: agent={agent_name} error_type={type(exc).__name__}")
        raise SkillDraftGenerationError("Skill 草稿生成失败，请检查快速模型配置后重试") from exc

    try:
        return normalize_skill_draft(response.text)
    except (ValueError, TypeError) as exc:
        logger.warning(f"Skill 草稿格式非法: agent={agent_name} error={exc}")
        raise SkillDraftGenerationError(f"生成结果格式不合法：{exc}") from exc


def _normalize_purpose(purpose: str) -> str:
    """用途必填，避免把空表单发给模型。"""
    normalized = (purpose or "").strip()
    if not normalized:
        raise ValueError("请填写 Skill 用途")
    return normalized


def normalize_skill_draft(content: str) -> dict[str, str]:
    """剥离模型包装并校验 frontmatter、依赖声明与内容预算。"""
    text = _strip_model_wrappers(content)
    if not text:
        raise ValueError("生成结果为空")
    if len(text.encode("utf-8")) > MAX_DRAFT_BYTES:
        raise ValueError("Skill 草稿不能超过 64 KiB")

    slug, name, description, metadata = parse_skill_markdown(text)
    declared = [key for key in DEPENDENCY_KEYS if metadata.get(key)]
    if declared:
        raise ValueError("草稿不能声明技能或工具依赖，请保存后手动配置")
    if len(description) > MAX_DESCRIPTION_CHARS:
        raise ValueError("Skill 描述过长")

    return {
        "content": text if text.endswith("\n") else f"{text}\n",
        "slug": slug,
        "name": name,
        "description": description,
    }


def _strip_model_wrappers(content: str) -> str:
    """去掉思考段和包裹整个文件的 Markdown 围栏，正文内围栏保持不变。"""
    text = content.strip() if isinstance(content, str) else ""
    text = re.sub(r"<think>.*?(?:</think>|$)", "", text, flags=re.IGNORECASE | re.DOTALL).strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if len(lines) >= 3 and lines[-1].strip() == "```":
            text = "\n".join(lines[1:-1]).strip()
    return text


def _normalize_tools(tools: list[str] | None) -> list[str]:
    """去重并限制工具提示数量，非法项直接丢弃。"""
    normalized: list[str] = []
    seen: set[str] = set()
    for item in tools or []:
        if not isinstance(item, str):
            continue
        name = item.strip()
        if not name or name in seen:
            continue
        seen.add(name)
        normalized.append(name[:64])
        if len(normalized) >= MAX_TOOLS:
            break
    return normalized
