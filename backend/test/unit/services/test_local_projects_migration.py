"""本地项目迁移的版本与脏数据守卫。"""

from types import SimpleNamespace

import pytest

from yuxi.migrations import local_projects
from yuxi.shared.errors import StateConflictError

pytestmark = [pytest.mark.asyncio, pytest.mark.unit]


class _Connection:
    def __init__(self, *, version: int, invalid_local_roots: int = 0):
        self.version = version
        self.invalid_local_roots = invalid_local_roots
        self.executed = []

    async def scalar(self, statement, _params=None):
        sql = str(statement)
        if "SELECT version" in sql:
            return self.version
        if "count(*)" in sql:
            return self.invalid_local_roots
        raise AssertionError(f"unexpected scalar: {sql}")

    async def execute(self, statement, _params=None):
        self.executed.append(str(statement))
        return SimpleNamespace(rowcount=1)


class _Manager:
    def __init__(self, connection):
        self.connection = connection
        self.async_engine = SimpleNamespace(begin=lambda: _Begin(self.connection))


class _Begin:
    def __init__(self, connection):
        self.connection = connection

    async def __aenter__(self):
        return self.connection

    async def __aexit__(self, *_args):
        return None


async def test_local_project_migration_rejects_unknown_version_before_ddl():
    """v1/v4 等历史或未来版本必须在写结构前明确失败。"""
    connection = _Connection(version=1)
    with pytest.raises(StateConflictError):
        await local_projects.convert(_Manager(connection))
    assert connection.executed == []


async def test_local_project_migration_rejects_empty_local_root_rows_before_ddl():
    """缺少 local_root 的本地项目必须先处理，不能靠迁移猜测路径。"""
    connection = _Connection(version=2, invalid_local_roots=1)
    with pytest.raises(StateConflictError, match="local_root"):
        await local_projects.convert(_Manager(connection))
    assert len(connection.executed) == 1
    assert "ADD COLUMN IF NOT EXISTS local_root" in connection.executed[0]
