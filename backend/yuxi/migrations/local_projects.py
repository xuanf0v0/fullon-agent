"""为桌面本地工作区 Project 增加 local 模式；默认只读，--apply 才写入。"""

import argparse
import asyncio
import json

from sqlalchemy import text

from yuxi.infrastructure.postgres.manager import pg_manager
from yuxi.shared.errors import StateConflictError

BUSINESS_DOMAIN = "business"
TARGET_VERSION = 3


async def audit(manager=pg_manager) -> dict:
    """只读检查 local_root 列、目录模式约束与版本。"""
    async with manager.async_engine.connect() as connection:
        version = await connection.scalar(
            text("SELECT version FROM yuxi_schema_migrations WHERE domain = :domain"),
            {"domain": BUSINESS_DOMAIN},
        )
        columns = await connection.execute(
            text(
                "SELECT column_name, is_nullable FROM information_schema.columns "
                "WHERE table_name = 'projects'"
            )
        )
        column_map = {str(row.column_name): str(row.is_nullable) for row in columns}
        constraints = await connection.execute(
            text(
                "SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint "
                "WHERE conrelid = 'projects'::regclass"
            )
        )
        definitions = {str(row.conname): str(row.definition) for row in constraints}
        invalid_local_roots = 0
        if "local_root" in column_map:
            invalid_local_roots = await connection.scalar(
                text(
                    "SELECT count(*) FROM projects "
                    "WHERE directory_mode = 'local' AND (local_root IS NULL OR local_root = '')"
                )
            )
    return {
        "domain_version": version,
        "target_version": TARGET_VERSION,
        "has_local_root": "local_root" in column_map,
        "directory_mode_allows_local": "local" in definitions.get("ck_projects_directory_mode", ""),
        "has_local_root_constraint": "ck_projects_local_root" in definitions,
        "invalid_local_roots": int(invalid_local_roots or 0),
    }


async def convert(manager=pg_manager) -> dict:
    """幂等补齐 local_root 列、约束与 business 版本号。"""
    async with manager.async_engine.begin() as connection:
        version = await connection.scalar(
            text("SELECT version FROM yuxi_schema_migrations WHERE domain = :domain"),
            {"domain": BUSINESS_DOMAIN},
        )
        if version not in {2, 3}:
            raise StateConflictError("仅支持 business v2 到 v3 的离线转换")
        # v2 没有 local_root 列，先补列再做脏数据检查。
        await connection.execute(
            text("ALTER TABLE projects ADD COLUMN IF NOT EXISTS local_root VARCHAR(512)")
        )
        invalid_local_roots = await connection.scalar(
            text(
                "SELECT count(*) FROM projects "
                "WHERE directory_mode = 'local' AND (local_root IS NULL OR local_root = '')"
            )
        )
        if invalid_local_roots:
            raise StateConflictError("存在缺少 local_root 的本地项目，请先处理后再迁移")
        # 旧库的目录模式约束需要重建；新库可能已有同名约束。
        await connection.execute(text("ALTER TABLE projects DROP CONSTRAINT IF EXISTS ck_projects_directory_mode"))
        await connection.execute(
            text(
                "ALTER TABLE projects ADD CONSTRAINT ck_projects_directory_mode "
                "CHECK (directory_mode IN ('managed', 'linked', 'local'))"
            )
        )
        # 每次都重建，确保既有库也获得空串保护。
        await connection.execute(text("ALTER TABLE projects DROP CONSTRAINT IF EXISTS ck_projects_local_root"))
        await connection.execute(
            text(
                "ALTER TABLE projects ADD CONSTRAINT ck_projects_local_root CHECK ("
                "(directory_mode = 'local' AND local_root IS NOT NULL AND local_root <> '') OR "
                "(directory_mode <> 'local' AND local_root IS NULL))"
            )
        )
        updated = await connection.execute(
            text(
                "UPDATE yuxi_schema_migrations SET version = :version, applied_at = CURRENT_TIMESTAMP "
                "WHERE domain = :domain"
            ),
            {"version": TARGET_VERSION, "domain": BUSINESS_DOMAIN},
        )
        if updated.rowcount != 1:
            raise RuntimeError("business schema 版本行不存在，请先由 app-init 建立基线")
    return {"domain": BUSINESS_DOMAIN, "version": TARGET_VERSION}


async def main() -> None:
    """输出审计结果或执行幂等转换。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="API/worker 停写后执行转换")
    args = parser.parse_args()
    pg_manager.initialize()
    try:
        result = await convert() if args.apply else await audit()
        print(json.dumps(result, ensure_ascii=False))
    finally:
        await pg_manager.close()


if __name__ == "__main__":
    asyncio.run(main())
