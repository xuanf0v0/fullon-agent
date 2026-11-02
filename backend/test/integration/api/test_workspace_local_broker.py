"""桌面本地文件代理登记 API 的真实 HTTP 契约。"""

from __future__ import annotations

import pytest

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


async def test_local_broker_registration_is_uid_scoped_and_revocable(test_client, standard_user):
    """普通用户只能登记自己的授权，连接状态不返回令牌。"""
    headers = standard_user["headers"]
    payload = {
        "urls": ["http://127.0.0.1:5175", "http://host.docker.internal:5175"],
        "token": "a" * 32,
        "folder_name": "docs",
    }

    invalid = await test_client.put(
        "/api/workspace/local-folder/broker",
        json={**payload, "urls": ["http://example.com:5175"]},
        headers=headers,
    )
    assert invalid.status_code == 400, invalid.text

    registered = await test_client.put("/api/workspace/local-folder/broker", json=payload, headers=headers)
    assert registered.status_code == 200, registered.text
    assert registered.json() == {"connected": True, "folder_name": "docs"}

    status = await test_client.get("/api/workspace/local-folder/broker", headers=headers)
    assert status.status_code == 200, status.text
    assert status.json() == {"connected": True, "folder_name": "docs"}
    assert "token" not in status.text

    removed = await test_client.delete("/api/workspace/local-folder/broker", headers=headers)
    assert removed.status_code == 200, removed.text
    assert removed.json() == {"connected": False}

    status = await test_client.get("/api/workspace/local-folder/broker", headers=headers)
    assert status.json() == {"connected": False, "folder_name": None}
