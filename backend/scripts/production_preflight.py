"""Fail fast when PoopSense is about to be deployed with demo-grade settings."""

from pathlib import Path
import sys


backend_root = Path(__file__).resolve().parents[1]
if str(backend_root) not in sys.path:
    sys.path.insert(0, str(backend_root))

from app.config import settings


def main() -> int:
    blockers = list(settings.production_blockers())
    if settings.app_env != "production":
        blockers.insert(0, "app_env_must_be_production")

    print(f"app_env={settings.app_env}")
    print(f"database_dialect={settings.database_dialect}")
    print(f"schema_strategy={'auto_create' if settings.auto_create_schema else 'migrations'}")
    print(f"worker_strategy={settings.worker_strategy}")
    print(f"agent_configured={str(bool(settings.llm_api_key)).lower()}")
    if blockers:
        print("production_ready=false")
        for blocker in blockers:
            print(f"blocker={blocker}")
        return 1

    print("production_ready=true")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
