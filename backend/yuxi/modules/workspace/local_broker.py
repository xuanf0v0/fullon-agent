"""桌面客户端本地文件代理的短期授权登记。

授权只存在 Redis，不写入业务数据库：它描述当前桌面进程的临时能力，
Electron 重启或用户断开后由前端重新登记。Agent 工具只拿到相对路径，
broker 自己绑定授权根目录并再次做路径校验。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from urllib.parse import urlsplit

from yuxi.infrastructure.redis import get_async_redis_client

LOCAL_BROKER_KEY_PREFIX = "yuxi:local-broker:"
LOCAL_BROKER_TTL_SECONDS = 12 * 60 * 60
ALLOWED_BROKER_HOSTS = {"127.0.0.1", "localhost", "host.docker.internal"}
TOKEN_PATTERN = r"^[A-Za-z0-9_-]{32,256}$"


@dataclass(frozen=True)
class LocalBrokerGrant:
    """当前用户桌面代理的连接信息。"""

    urls: tuple[str, ...]
    token: str
    folder_name: str


def _key(uid: str) -> str:
    return f"{LOCAL_BROKER_KEY_PREFIX}{uid}"


def _normalize_url(value: str) -> str:
    """只接受本机/主机网关上的 HTTP 代理地址，拒绝额外路径和凭据。"""
    if not isinstance(value, str) or not value.strip():
        raise ValueError("本地代理地址不能为空")
    parsed = urlsplit(value.strip())
    if parsed.scheme != "http" or not parsed.hostname:
        raise ValueError("本地代理必须使用 HTTP 地址")
    if parsed.hostname not in ALLOWED_BROKER_HOSTS:
        raise ValueError("本地代理只允许本机或 Docker 主机网关")
    if parsed.port is None or not 1024 <= parsed.port <= 65535:
        raise ValueError("本地代理端口无效")
    if parsed.username or parsed.password or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        raise ValueError("本地代理地址不能包含路径、查询或凭据")
    return f"http://{parsed.hostname}:{parsed.port}"


def normalize_grant(*, urls: list[str], token: str, folder_name: str) -> LocalBrokerGrant:
    """校验并归一化前端登记的代理信息。"""
    if not isinstance(urls, list) or not 1 <= len(urls) <= 4:
        raise ValueError("本地代理地址数量无效")
    normalized_urls = tuple(dict.fromkeys(_normalize_url(url) for url in urls))
    if not isinstance(token, str) or not re.fullmatch(TOKEN_PATTERN, token):
        raise ValueError("本地代理令牌无效")
    if not isinstance(folder_name, str) or not folder_name.strip() or len(folder_name.strip()) > 120:
        raise ValueError("本地文件夹名称无效")
    return LocalBrokerGrant(urls=normalized_urls, token=token, folder_name=folder_name.strip())


async def save_local_broker_grant(*, uid: str, urls: list[str], token: str, folder_name: str) -> LocalBrokerGrant:
    """登记当前用户的桌面代理，后续 Agent 工具按 uid 读取。"""
    grant = normalize_grant(urls=urls, token=token, folder_name=folder_name)
    redis = await get_async_redis_client()
    await redis.set(
        _key(uid),
        json.dumps({"urls": list(grant.urls), "token": grant.token, "folder_name": grant.folder_name}),
        ex=LOCAL_BROKER_TTL_SECONDS,
    )
    return grant


async def get_local_broker_grant(uid: str) -> LocalBrokerGrant | None:
    """读取当前用户授权；不存在或数据损坏时视为未连接。"""
    redis = await get_async_redis_client()
    raw = await redis.get(_key(uid))
    if not raw:
        return None
    try:
        payload = json.loads(raw)
        grant = normalize_grant(
            urls=payload.get("urls"),
            token=payload.get("token"),
            folder_name=payload.get("folder_name"),
        )
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    # 活跃使用期间续期；桌面端长时间不访问时授权自然过期。
    await redis.expire(_key(uid), LOCAL_BROKER_TTL_SECONDS)
    return grant


async def delete_local_broker_grant(uid: str) -> None:
    """断开工作区时立即撤销 Agent 读取能力。"""
    redis = await get_async_redis_client()
    await redis.delete(_key(uid))
