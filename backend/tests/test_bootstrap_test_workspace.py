"""Offline contract tests for the explicit, transactional demo initializer."""

import hashlib
import importlib.util
import json
import sys
import warnings
from dataclasses import replace
from pathlib import Path

import pytest
from sqlalchemy import Boolean, Column, Integer, MetaData, String, Table, create_engine, event, inspect, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "bootstrap_test_workspace.py"
SPEC = importlib.util.spec_from_file_location("bootstrap_test_workspace_under_test", SCRIPT)
bootstrap = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = bootstrap
SPEC.loader.exec_module(bootstrap)

DEVICE_KEY = "unit-only-device-credential-0000000000000001"
HOUSEHOLD_KEY = "unit-only-household-credential-000000000001"
WORKSPACE = bootstrap.WorkspaceSpec(
    household_id="hh_hardware_test", owner_user_id="u_hardware_test_owner",
    member_id="m_hardware_test_001", device_id="dev_hardware_test_001",
)
REVISION = "offline-test-head"


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


@pytest.fixture
def database():
    engine = create_engine("sqlite://")
    metadata = MetaData()
    # These six identities are deliberately isolated from the application's
    # configuration/engine and all application data tables.
    Table("households", metadata, Column("id", String, primary_key=True),
          Column("name", String), Column("active", Boolean))
    Table("users", metadata, Column("id", String, primary_key=True),
          Column("display_name", String), Column("active", Boolean))
    Table("household_memberships", metadata, Column("id", Integer, primary_key=True),
          Column("household_id", String), Column("user_id", String),
          Column("role", String), Column("active", Boolean))
    Table("api_credentials", metadata, Column("api_key_hash", String, primary_key=True),
          Column("user_id", String), Column("active", Boolean))
    Table("household_members", metadata, Column("id", String, primary_key=True),
          Column("household_id", String), Column("linked_user_id", String),
          Column("display_name", String), Column("active", Boolean))
    Table("device_bindings", metadata, Column("device_id", String, primary_key=True),
          Column("household_id", String), Column("api_key_hash", String), Column("active", Boolean))
    version = Table("alembic_version", metadata, Column("version_num", String, primary_key=True))
    metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(version.insert().values(version_num=REVISION))
    yield engine, metadata.tables
    engine.dispose()


def run(database, **kwargs):
    with Session(database[0]) as session:
        return bootstrap.bootstrap_workspace(
            session, kwargs.pop("spec", WORKSPACE), kwargs.pop("device_key", DEVICE_KEY),
            kwargs.pop("household_key", HOUSEHOLD_KEY), expected_revisions=(REVISION,), **kwargs,
        )


def snapshot(database):
    with database[0].connect() as connection:
        return {name: [dict(row) for row in connection.execute(select(table)).mappings()]
                for name, table in database[1].items()}


def mutate(database, table_name, **values):
    with database[0].begin() as connection:
        connection.execute(database[1][table_name].update().values(**values))


def test_creates_complete_owner_and_device_identity_with_only_hashes(database):
    assert run(database) == "created"
    state = snapshot(database)
    assert all(len(state[name]) == 1 for name in bootstrap.TABLE_NAMES)
    assert state["household_memberships"][0]["role"] == "owner"
    assert state["household_members"][0]["linked_user_id"] == WORKSPACE.owner_user_id
    assert state["household_members"][0]["household_id"] == WORKSPACE.household_id
    assert state["device_bindings"][0]["api_key_hash"] == digest(DEVICE_KEY)
    assert state["api_credentials"][0]["api_key_hash"] == digest(HOUSEHOLD_KEY)
    assert DEVICE_KEY not in json.dumps(state) and HOUSEHOLD_KEY not in json.dumps(state)


def test_idempotent_rerun_preserves_existing_display_names(database):
    run(database)
    before = snapshot(database)
    assert run(database, spec=replace(WORKSPACE, household_name="New label", member_name="Changed")) == "unchanged"
    assert snapshot(database) == before


@pytest.mark.parametrize("change", [
    {"device_key": "different-private-device-credential-000000001"},
    {"household_key": "different-private-household-credential-000001"},
    {"spec": replace(WORKSPACE, member_id="another_member")},
    {"spec": replace(WORKSPACE, owner_user_id="another_owner")},
])
def test_changed_credentials_or_identity_never_overwrite(database, change):
    run(database)
    before = snapshot(database)
    with pytest.raises(bootstrap.BootstrapError, match="EXISTING_IDENTITY_CONFLICT"):
        run(database, **change)
    assert snapshot(database) == before


@pytest.mark.parametrize(("table_name", "values"), [
    ("device_bindings", {"household_id": "another_household"}),
    ("household_members", {"household_id": "another_household"}),
    ("household_members", {"linked_user_id": "another_owner"}),
    ("household_memberships", {"role": "viewer"}),
    ("api_credentials", {"user_id": "another_owner"}),
    *((name, {"active": False}) for name in bootstrap.TABLE_NAMES),
])
def test_existing_binding_or_disabled_identity_is_not_adopted(database, table_name, values):
    run(database)
    mutate(database, table_name, **values)
    before = snapshot(database)
    with pytest.raises(bootstrap.BootstrapError, match="EXISTING_IDENTITY_CONFLICT"):
        run(database)
    assert snapshot(database) == before


@pytest.mark.parametrize(("table_name", "values"), [
    ("household_memberships", {"household_id": WORKSPACE.household_id,
                              "user_id": "another_owner", "role": "owner", "active": True}),
    ("household_memberships", {"household_id": "other_household",
                              "user_id": WORKSPACE.owner_user_id, "role": "owner", "active": True}),
    ("api_credentials", {"api_key_hash": digest("another-credential"),
                         "user_id": WORKSPACE.owner_user_id, "active": True}),
    ("device_bindings", {"device_id": "another_device", "household_id": "other_household",
                         "api_key_hash": digest(DEVICE_KEY), "active": True}),
    ("device_bindings", {"device_id": "another_device", "household_id": "other_household",
                         "api_key_hash": digest(HOUSEHOLD_KEY), "active": True}),
    ("api_credentials", {"api_key_hash": digest(DEVICE_KEY), "user_id": "other_owner", "active": True}),
])
def test_conflicting_owner_relationship_or_reused_key_rolls_back(database, table_name, values):
    with database[0].begin() as connection:
        connection.execute(database[1][table_name].insert().values(**values))
    before = snapshot(database)
    with pytest.raises(bootstrap.BootstrapError, match="EXISTING_IDENTITY_CONFLICT"):
        run(database)
    assert snapshot(database) == before


def test_partial_existing_household_requires_explicit_review_not_adoption(database):
    with database[0].begin() as connection:
        connection.execute(database[1]["households"].insert().values(
            id=WORKSPACE.household_id, name="Existing household", active=True))
    before = snapshot(database)
    with pytest.raises(bootstrap.BootstrapError, match="EXISTING_IDENTITY_CONFLICT"):
        run(database)
    assert snapshot(database) == before


def test_failure_on_final_insert_rolls_back_all_prior_inserts(database):
    before = snapshot(database)

    def fail_final_insert(connection, cursor, statement, parameters, context, executemany):
        if statement.startswith("INSERT INTO device_bindings"):
            raise OperationalError("simulated insert", {}, Exception("offline failure"))

    event.listen(database[0], "before_cursor_execute", fail_final_insert)
    try:
        with pytest.raises(OperationalError):
            run(database)
    finally:
        event.remove(database[0], "before_cursor_execute", fail_final_insert)
    assert snapshot(database) == before


@pytest.mark.parametrize("missing", ["alembic_version", "device_bindings"])
def test_unmigrated_database_is_never_modified(database, missing):
    database[1][missing].drop(database[0])
    before = inspect(database[0]).get_table_names()
    with pytest.raises(bootstrap.BootstrapError, match="DATABASE_NOT_MIGRATED"):
        run(database)
    assert inspect(database[0]).get_table_names() == before


def test_wrong_migration_revision_never_writes_identity(database):
    mutate(database, "alembic_version", version_num="old-head")
    before = snapshot(database)
    with pytest.raises(bootstrap.BootstrapError, match="MIGRATION_REVISION_MISMATCH"):
        run(database)
    assert snapshot(database) == before


def test_existing_caller_transaction_is_not_committed_or_rolled_back(database):
    with Session(database[0]) as session:
        with session.begin():
            session.execute(database[1]["households"].insert().values(
                id="caller_owned_pending", name="Pending caller work", active=True))
            with pytest.raises(bootstrap.BootstrapError, match="SESSION_MUST_BE_IDLE"):
                bootstrap.bootstrap_workspace(session, WORKSPACE, DEVICE_KEY, HOUSEHOLD_KEY,
                                              expected_revisions=(REVISION,))
            assert session.in_transaction()
            assert session.scalar(select(database[1]["households"].c.id)) == "caller_owned_pending"
        assert snapshot(database)["households"][0]["id"] == "caller_owned_pending"


def test_migration_heads_are_read_without_loading_application_configuration(monkeypatch):
    import builtins

    original_import = builtins.__import__

    def guarded_import(name, *args, **kwargs):
        if name == "app" or name.startswith("app."):
            pytest.fail("Initializer must not load app configuration or its .env files")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guarded_import)
    assert bootstrap.migration_heads()


def arguments():
    return ["--household-id", WORKSPACE.household_id, "--owner-user-id", WORKSPACE.owner_user_id,
            "--member-id", WORKSPACE.member_id, "--device-id", WORKSPACE.device_id]


def environment():
    return {"POOPSENSE_APP_ENV": "demo", "POOPSENSE_DATABASE_URL": "postgresql://local/test_demo",
            "POOPSENSE_TEST_DEVICE_KEY": DEVICE_KEY, "POOPSENSE_TEST_HOUSEHOLD_KEY": HOUSEHOLD_KEY}


@pytest.mark.parametrize("patch", [
    {"POOPSENSE_APP_ENV": ""}, {"POOPSENSE_APP_ENV": "development"},
    {"POOPSENSE_APP_ENV": "production"}, {"POOPSENSE_APP_ENV": "DEMO"},
    {"POOPSENSE_DATABASE_URL": ""}, {"POOPSENSE_DATABASE_URL": "sqlite:///database.db"},
    {"POOPSENSE_DATABASE_URL": "broken-private-url"},
    {"POOPSENSE_DATABASE_URL": "postgresql+asyncpg://local/test_demo"},
    {"POOPSENSE_DATABASE_URL": "postgresql://local"},
])
def test_cli_environment_guards_before_connecting_or_prompting(monkeypatch, capsys, patch):
    def forbidden(*args, **kwargs):
        pytest.fail("Neither connecting nor prompting is allowed before environment validation")

    monkeypatch.setattr(bootstrap, "create_engine", forbidden)
    monkeypatch.setattr(bootstrap.getpass, "getpass", forbidden)
    env = environment() | patch
    assert bootstrap.main(arguments(), environ=env) == 1
    output = capsys.readouterr()
    assert not output.out
    assert DEVICE_KEY not in output.err and HOUSEHOLD_KEY not in output.err
    assert "broken-private-url" not in output.err


@pytest.mark.parametrize("patch", [
    {"POOPSENSE_TEST_DEVICE_KEY": "dev-secret"},
    {"POOPSENSE_TEST_HOUSEHOLD_KEY": "household-secret"},
    {"POOPSENSE_TEST_DEVICE_KEY": ""},
    {"POOPSENSE_TEST_HOUSEHOLD_KEY": DEVICE_KEY},
    {"POOPSENSE_TEST_DEVICE_KEY": "\n" + DEVICE_KEY},
])
def test_cli_rejects_public_empty_shared_or_control_character_keys(monkeypatch, capsys, patch):
    monkeypatch.setattr(bootstrap, "create_engine", lambda *a, **kw: pytest.fail("No database connection"))
    monkeypatch.setattr(bootstrap.getpass, "getpass", lambda *a: pytest.fail("No fallback for empty env key"))
    assert bootstrap.main(arguments(), environ=environment() | patch) == 1
    assert DEVICE_KEY not in capsys.readouterr().err


def test_unknown_secret_cli_argument_is_not_echoed(capsys):
    assert bootstrap.main(arguments() + ["--device-key", DEVICE_KEY], environ=environment()) == 1
    output = capsys.readouterr()
    assert DEVICE_KEY not in output.err + output.out
    assert "KEYS_ARE_NOT_CLI_ARGUMENTS" in output.err


def test_hidden_prompt_accepts_keys_without_echo(monkeypatch):
    prompts = []
    monkeypatch.setattr(bootstrap.getpass, "getpass", lambda prompt: prompts.append(prompt) or DEVICE_KEY)
    assert bootstrap.read_key({}, "POOPSENSE_TEST_DEVICE_KEY", "Private key: ") == DEVICE_KEY
    assert prompts == ["Private key: "]


def test_prompt_refuses_unsafe_echo_fallback(monkeypatch):
    def unavailable(prompt):
        warnings.warn("No hidden terminal", bootstrap.getpass.GetPassWarning)
        pytest.fail("Input must not continue after hidden terminal warning")

    monkeypatch.setattr(bootstrap.getpass, "getpass", unavailable)
    with pytest.raises(bootstrap.BootstrapError, match="HIDDEN_KEY_INPUT_UNAVAILABLE"):
        bootstrap.read_key({}, "POOPSENSE_TEST_DEVICE_KEY", "Private key: ")


def test_cli_success_contains_only_public_ids_and_never_credentials(database, monkeypatch, capsys):
    def offline_engine(url, **kwargs):
        assert url.drivername == "postgresql+psycopg"
        assert kwargs["hide_parameters"] and not kwargs["echo"]
        return database[0]

    monkeypatch.setattr(bootstrap, "create_engine", offline_engine)
    monkeypatch.setattr(bootstrap, "migration_heads", lambda: (REVISION,))
    monkeypatch.setattr(database[0], "dispose", lambda: None)
    assert bootstrap.main(arguments(), environ=environment()) == 0
    output = capsys.readouterr()
    response = json.loads(output.out)
    assert response == {"status": "created", "scope": "test_demo", "household_id": WORKSPACE.household_id,
                        "owner_user_id": WORKSPACE.owner_user_id, "member_id": WORKSPACE.member_id,
                        "device_id": WORKSPACE.device_id}
    for private in (DEVICE_KEY, HOUSEHOLD_KEY, digest(DEVICE_KEY), digest(HOUSEHOLD_KEY)):
        assert private not in output.out + output.err


def test_cli_database_error_suppresses_driver_details(monkeypatch, capsys):
    def failed_engine(*args, **kwargs):
        raise OperationalError("connect with " + DEVICE_KEY, {}, Exception(HOUSEHOLD_KEY))

    monkeypatch.setattr(bootstrap, "create_engine", failed_engine)
    monkeypatch.setattr(bootstrap, "migration_heads", lambda: (REVISION,))
    assert bootstrap.main(arguments(), environ=environment()) == 1
    output = capsys.readouterr()
    assert "DATABASE_OPERATION_FAILED" in output.err
    assert DEVICE_KEY not in output.err + output.out and HOUSEHOLD_KEY not in output.err + output.out
