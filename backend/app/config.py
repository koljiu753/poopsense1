import os
from dataclasses import dataclass
from pathlib import Path


def _load_local_env() -> None:
    """Load developer-only secrets without overriding real environment variables."""
    path = Path(__file__).resolve().parents[1] / ".env.local"
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


_load_local_env()


DEFAULT_DATABASE_URL = (
    "sqlite:////tmp/poopsense-demo.db"
    if os.getenv("VERCEL")
    else "sqlite:///./poopsense-local.db"
)


def _env_flag(name: str, default: str) -> bool:
    return os.getenv(name, default).lower() in {"1", "true", "yes"}


@dataclass(frozen=True)
class Settings:
    app_env: str = os.getenv(
        "POOPSENSE_APP_ENV", "demo" if os.getenv("VERCEL") else "development"
    ).lower()
    database_url: str = os.getenv(
        "POOPSENSE_DATABASE_URL", DEFAULT_DATABASE_URL
    )
    reliable_confidence_threshold: float = float(
        os.getenv("POOPSENSE_RELIABLE_CONFIDENCE_THRESHOLD", "0.70")
    )
    bootstrap_demo_device: bool = _env_flag("POOPSENSE_BOOTSTRAP_DEMO_DEVICE", "true")
    bootstrap_demo_data: bool = _env_flag("POOPSENSE_BOOTSTRAP_DEMO_DATA", "true")
    auto_create_schema: bool = _env_flag("POOPSENSE_AUTO_CREATE_SCHEMA", "true")
    outbox_max_attempts: int = int(os.getenv("POOPSENSE_OUTBOX_MAX_ATTEMPTS", "3"))
    outbox_retry_base_seconds: int = int(
        os.getenv("POOPSENSE_OUTBOX_RETRY_BASE_SECONDS", "5")
    )
    outbox_lease_seconds: int = int(os.getenv("POOPSENSE_OUTBOX_LEASE_SECONDS", "60"))
    inline_worker_enabled: bool = _env_flag("POOPSENSE_INLINE_WORKER_ENABLED", "true")
    external_worker_enabled: bool = _env_flag(
        "POOPSENSE_EXTERNAL_WORKER_ENABLED", "false"
    )
    http_worker_enabled: bool = _env_flag("POOPSENSE_HTTP_WORKER_ENABLED", "false")
    worker_token: str = os.getenv(
        "POOPSENSE_WORKER_TOKEN", os.getenv("CRON_SECRET", "")
    )
    inline_worker_poll_seconds: float = float(
        os.getenv("POOPSENSE_INLINE_WORKER_POLL_SECONDS", "1")
    )
    inline_worker_batch_size: int = int(
        os.getenv("POOPSENSE_INLINE_WORKER_BATCH_SIZE", "20")
    )
    llm_api_key: str = os.getenv(
        "POOPSENSE_LLM_API_KEY", os.getenv("DEEPSEEK_API_KEY", "")
    )
    llm_base_url: str = os.getenv("POOPSENSE_LLM_BASE_URL", "https://api.deepseek.com")
    llm_model: str = os.getenv("POOPSENSE_LLM_MODEL", "deepseek-v4-pro")
    llm_timeout_seconds: float = float(os.getenv("POOPSENSE_LLM_TIMEOUT_SECONDS", "30"))
    llm_proactive_enabled: bool = _env_flag("POOPSENSE_LLM_PROACTIVE_ENABLED", "true")
    # Historical competition integration, excluded from the sensor product.
    legacy_robot_enabled: bool = _env_flag("POOPSENSE_LEGACY_ROBOT_ENABLED", "false")
    robot_host_url: str = os.getenv("POOPSENSE_ROBOT_HOST_URL", "http://localhost:5000")
    robot_timeout_seconds: float = float(os.getenv("POOPSENSE_ROBOT_TIMEOUT_SECONDS", "5"))
    robot_trajectory_path: str = os.getenv(
        "POOPSENSE_ROBOT_TRAJECTORY_PATH",
        str(Path(__file__).resolve().parents[1] / "robot_trajectories" / "deliver_water.json"),
    )
    vbot_bridge_enabled: bool = _env_flag("POOPSENSE_VBOT_BRIDGE_ENABLED", "false")
    vbot_bridge_url: str = os.getenv(
        "POOPSENSE_VBOT_BRIDGE_URL", "http://192.168.126.2:8765"
    )
    vbot_bridge_timeout_seconds: float = float(
        os.getenv("POOPSENSE_VBOT_BRIDGE_TIMEOUT_SECONDS", "5")
    )
    vbot_route_name: str = os.getenv(
        "POOPSENSE_VBOT_ROUTE_NAME", "poopsense_water_delivery"
    )
    vbot_route_timeout_seconds: float = float(
        os.getenv("POOPSENSE_VBOT_ROUTE_TIMEOUT_SECONDS", "180")
    )
    robot_handover_timeout_seconds: float = float(
        os.getenv("POOPSENSE_ROBOT_HANDOVER_TIMEOUT_SECONDS", "60")
    )
    cors_origins: tuple[str, ...] = tuple(
        item.strip() for item in os.getenv(
            "POOPSENSE_CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
        ).split(",") if item.strip()
    )
    cors_origin_regex: str = os.getenv(
        "POOPSENSE_CORS_ORIGIN_REGEX",
        r"^https?://(localhost|127\.0\.0\.1|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?::\d+)?$",
    )

    @property
    def database_dialect(self) -> str:
        return self.database_url.split(":", 1)[0].split("+", 1)[0].lower()

    @property
    def worker_strategy(self) -> str:
        if self.inline_worker_enabled and self.external_worker_enabled:
            return "conflict"
        if self.inline_worker_enabled:
            return "inline"
        if self.external_worker_enabled:
            return "external"
        return "disabled"

    def production_blockers(self) -> tuple[str, ...]:
        """Return safe, non-secret reasons this configuration is not production-ready."""
        blockers: list[str] = []
        if self.app_env not in {"development", "demo", "production"}:
            blockers.append("app_env_invalid")
        if self.database_dialect != "postgresql":
            blockers.append("database_must_be_postgresql")
        if self.bootstrap_demo_device or self.bootstrap_demo_data:
            blockers.append("demo_bootstrap_must_be_disabled")
        if self.auto_create_schema:
            blockers.append("schema_must_be_managed_by_migrations")
        if self.worker_strategy != "external":
            blockers.append("external_worker_required")
        if self.http_worker_enabled and not self.external_worker_enabled:
            blockers.append("http_worker_requires_external_worker")
        if self.http_worker_enabled and not self.worker_token:
            blockers.append("worker_token_required")
        if self.llm_proactive_enabled and not self.llm_api_key:
            blockers.append("llm_key_required_for_proactive_agent")
        # This release still ships a shared browser credential, not an individual
        # login/session lifecycle. Infrastructure flags cannot certify that gap.
        # Remove only together with the replacement auth flow and isolation tests;
        # deliberately do not provide an environment-variable bypass.
        blockers.append("individual_user_auth_not_implemented")
        return tuple(blockers)


settings = Settings()
