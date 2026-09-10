from app.config import Settings


def test_infrastructure_configuration_cannot_certify_missing_user_auth():
    configured = Settings(
        app_env="production",
        database_url="postgresql+psycopg://example.invalid/poopsense",
        bootstrap_demo_device=False,
        bootstrap_demo_data=False,
        auto_create_schema=False,
        inline_worker_enabled=False,
        external_worker_enabled=True,
        http_worker_enabled=False,
        worker_token="",
        llm_proactive_enabled=True,
        llm_api_key="model-token",
    )

    assert configured.database_dialect == "postgresql"
    assert configured.worker_strategy == "external"
    assert configured.production_blockers() == ("individual_user_auth_not_implemented",)


def test_demo_defaults_are_never_mistaken_for_production():
    configured = Settings(
        app_env="demo",
        database_url="sqlite:////tmp/poopsense-demo.db",
        bootstrap_demo_device=True,
        bootstrap_demo_data=True,
        auto_create_schema=True,
        inline_worker_enabled=False,
        external_worker_enabled=False,
        http_worker_enabled=False,
        llm_proactive_enabled=True,
        llm_api_key="",
    )

    assert configured.worker_strategy == "disabled"
    assert configured.production_blockers() == (
        "database_must_be_postgresql",
        "demo_bootstrap_must_be_disabled",
        "schema_must_be_managed_by_migrations",
        "external_worker_required",
        "llm_key_required_for_proactive_agent",
        "individual_user_auth_not_implemented",
    )


def test_conflicting_worker_modes_are_rejected_for_production():
    configured = Settings(
        database_url="postgresql://example.invalid/poopsense",
        bootstrap_demo_device=False,
        bootstrap_demo_data=False,
        auto_create_schema=False,
        inline_worker_enabled=True,
        external_worker_enabled=True,
        http_worker_enabled=False,
        worker_token="worker-token",
        llm_proactive_enabled=False,
    )

    assert configured.worker_strategy == "conflict"
    assert "external_worker_required" in configured.production_blockers()


def test_http_worker_requires_external_mode_and_a_token():
    configured = Settings(
        database_url="postgresql://example.invalid/poopsense",
        bootstrap_demo_device=False,
        bootstrap_demo_data=False,
        auto_create_schema=False,
        inline_worker_enabled=False,
        external_worker_enabled=False,
        http_worker_enabled=True,
        worker_token="",
        llm_proactive_enabled=False,
    )

    blockers = configured.production_blockers()
    assert "external_worker_required" in blockers
    assert "http_worker_requires_external_worker" in blockers
    assert "worker_token_required" in blockers


def test_unknown_environment_name_cannot_bypass_the_gate():
    configured = Settings(app_env="prod")
    assert configured.production_blockers()[0] == "app_env_invalid"


def test_environment_variable_cannot_bypass_missing_auth(monkeypatch):
    monkeypatch.setenv("POOPSENSE_AUTH_ENABLED", "true")
    assert "individual_user_auth_not_implemented" in Settings().production_blockers()
