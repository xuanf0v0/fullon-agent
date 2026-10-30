"""审计并升级定时任务的一次性执行方式；默认只读，--apply 才写入。"""

import argparse
import asyncio
import json

from sqlalchemy import text

from yuxi.infrastructure.postgres.manager import pg_manager
from yuxi.shared.errors import StateConflictError

BUSINESS_DOMAIN = "business"
TARGET_VERSION = 2


async def audit(manager=pg_manager) -> dict:
    """只读检查列、可空性与版本现状。"""
    async with manager.async_engine.connect() as connection:
        version = await connection.scalar(
            text("SELECT version FROM yuxi_schema_migrations WHERE domain = :domain"),
            {"domain": BUSINESS_DOMAIN},
        )
        rows = await connection.execute(
            text(
                "SELECT column_name, is_nullable FROM information_schema.columns "
                "WHERE table_name = 'scheduled_agent_jobs'"
            )
        )
        columns = {str(row.column_name): str(row.is_nullable) for row in rows}
        jobs = await connection.scalar(text("SELECT count(*) FROM scheduled_agent_jobs"))
    return {
        "domain_version": version,
        "target_version": TARGET_VERSION,
        "has_schedule_kind": "schedule_kind" in columns,
        "has_run_at": "run_at" in columns,
        "cron_nullable": columns.get("cron_expression") == "YES",
        "jobs": jobs,
    }


async def convert(manager=pg_manager) -> dict:
    """幂等补齐一次性调度列、约束与 business 版本号。"""
    async with manager.async_engine.begin() as connection:
        version = await connection.scalar(
            text("SELECT version FROM yuxi_schema_migrations WHERE domain = :domain"),
            {"domain": BUSINESS_DOMAIN},
        )
        if version not in {1, 2}:
            raise StateConflictError("仅支持 business v1 到 v2 的离线转换")
        await connection.execute(
            text(
                "ALTER TABLE scheduled_agent_jobs "
                "ADD COLUMN IF NOT EXISTS schedule_kind VARCHAR(16) NOT NULL DEFAULT 'cron'"
            )
        )
        await connection.execute(
            text("ALTER TABLE scheduled_agent_jobs ADD COLUMN IF NOT EXISTS run_at TIMESTAMPTZ")
        )
        await connection.execute(
            text("ALTER TABLE scheduled_agent_jobs ALTER COLUMN cron_expression DROP NOT NULL")
        )
        for name, expression in (
            ("ck_scheduled_agent_jobs_schedule_kind", "schedule_kind IN ('cron', 'once')"),
            (
                "ck_scheduled_agent_jobs_schedule_shape",
                "(schedule_kind = 'cron' AND cron_expression IS NOT NULL AND run_at IS NULL) "
                "OR (schedule_kind = 'once' AND run_at IS NOT NULL AND cron_expression IS NULL)",
            ),
        ):
            exists = await connection.scalar(
                text(
                    "SELECT EXISTS (SELECT 1 FROM pg_constraint "
                    "WHERE conrelid = 'scheduled_agent_jobs'::regclass AND conname = :name)"
                ),
                {"name": name},
            )
            if not exists:
                await connection.execute(
                    text(
                        f"ALTER TABLE scheduled_agent_jobs "
                        f"ADD CONSTRAINT {name} CHECK ({expression})"
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
