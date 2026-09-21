"""Provision one isolated demo identity in an already migrated PostgreSQL database.

This command deliberately does not import application configuration or load .env
files. Credentials are accepted only through the named environment variables or
hidden terminal input. It does not provide individual production login.
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
import re
import sys
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Sequence

from alembic.script import ScriptDirectory
from sqlalchemy import MetaData, Table, create_engine, inspect, select, text
from sqlalchemy.engine import URL, make_url
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session


class BootstrapError(Exception):
    """A safe, fixed error code; never include credentials or connection details."""


@dataclass(frozen=True)
class WorkspaceSpec:
    household_id: str
    owner_user_id: str
    member_id: str
    device_id: str
    household_name: str = "Hardware test household"
    owner_name: str = "Test owner"
    member_name: str = "Test member"


TABLE_NAMES = (
    "households", "users", "household_memberships", "api_credentials",
    "household_members", "device_bindings",
)
PUBLIC_KEYS = {"dev-secret", "household-secret", "viewer-secret"}


def validate_inputs(spec: WorkspaceSpec, device_key: str, household_key: str) -> None:
    for value in (spec.household_id, spec.owner_user_id, spec.member_id, spec.device_id):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}", value):
            raise BootstrapError("INVALID_IDENTIFIER")
    for value in (spec.household_name, spec.owner_name, spec.member_name):
        if not value.strip() or len(value) > 100 or any(ord(c) < 32 for c in value):
            raise BootstrapError("INVALID_DISPLAY_NAME")
    for key in (device_key, household_key):
        if key in PUBLIC_KEYS or not re.fullmatch(r"[\x21-\x7e]{32,256}", key):
            raise BootstrapError("KEY_MUST_BE_PRIVATE_32_TO_256_ASCII_CHARACTERS")
    if device_key == household_key:
        raise BootstrapError("DEVICE_AND_HOUSEHOLD_KEYS_MUST_DIFFER")


def migration_heads() -> tuple[str, ...]:
    directory = Path(__file__).resolve().parents[1] / "migrations"
    heads = tuple(ScriptDirectory(str(directory)).get_heads())
    if not heads:
        raise BootstrapError("LOCAL_MIGRATIONS_UNAVAILABLE")
    return heads


def bootstrap_workspace(
    session: Session,
    spec: WorkspaceSpec,
    device_key: str,
    household_key: str,
    *,
    expected_revisions: Sequence[str] | None = None,
) -> str:
    """Atomically create or verify the complete test identity; never adopt partials.

    The caller supplies an idle Session. SQLite is supported here for isolated
    tests; only the command-line entry point is permitted to connect to a demo
    PostgreSQL database. This function performs no schema changes.
    """
    validate_inputs(spec, device_key, household_key)
    revisions = set(migration_heads() if expected_revisions is None else expected_revisions)
    if not revisions:
        raise BootstrapError("LOCAL_MIGRATIONS_UNAVAILABLE")
    if session.in_transaction():
        raise BootstrapError("SESSION_MUST_BE_IDLE")
    device_hash = hashlib.sha256(device_key.encode("utf-8")).hexdigest()
    household_hash = hashlib.sha256(household_key.encode("utf-8")).hexdigest()

    with session.begin():
        connection = session.connection()
        # Serialize invocations of this initializer, including checks on keys
        # whose existing schema does not declare a uniqueness constraint.
        if connection.dialect.name == "postgresql":
            connection.execute(text("SELECT pg_advisory_xact_lock(70666733481921)"))
        existing_tables = set(inspect(connection).get_table_names())
        if not set((*TABLE_NAMES, "alembic_version")).issubset(existing_tables):
            raise BootstrapError("DATABASE_NOT_MIGRATED")
        metadata = MetaData()
        version = Table("alembic_version", metadata, autoload_with=connection)
        if set(session.execute(select(version.c.version_num)).scalars()) != revisions:
            raise BootstrapError("MIGRATION_REVISION_MISMATCH")
        tables = {
            name: Table(name, metadata, autoload_with=connection)
            for name in TABLE_NAMES
        }
        households, users, memberships, credentials, members, devices = (
            tables[name] for name in TABLE_NAMES
        )

        def rows(table: Table, condition):
            return session.execute(select(table).where(condition)).mappings().all()

        def one(table: Table, condition):
            return session.execute(select(table).where(condition)).mappings().one_or_none()

        def require(condition: bool) -> None:
            if not condition:
                raise BootstrapError("EXISTING_IDENTITY_CONFLICT")

        household = one(households, households.c.id == spec.household_id)
        user = one(users, users.c.id == spec.owner_user_id)
        membership = one(memberships, (memberships.c.household_id == spec.household_id)
                         & (memberships.c.user_id == spec.owner_user_id))
        credential = one(credentials, credentials.c.api_key_hash == household_hash)
        member = one(members, members.c.id == spec.member_id)
        device = one(devices, devices.c.device_id == spec.device_id)

        # Reject alternate owner relationships and credential reuse, including
        # disabled rows. Disabled identities are not silently reactivated.
        for row in rows(memberships, memberships.c.user_id == spec.owner_user_id):
            require(row["household_id"] == spec.household_id
                    and row["role"] == "owner" and row["active"])
        for row in rows(memberships, (memberships.c.household_id == spec.household_id)
                        & (memberships.c.role == "owner")):
            require(row["user_id"] == spec.owner_user_id and row["active"])
        for row in rows(credentials, credentials.c.user_id == spec.owner_user_id):
            require(row["api_key_hash"] == household_hash and row["active"])
        for row in rows(members, members.c.linked_user_id == spec.owner_user_id):
            require(row["id"] == spec.member_id
                    and row["household_id"] == spec.household_id and row["active"])
        for row in rows(devices, devices.c.api_key_hash == device_hash):
            require(row["device_id"] == spec.device_id)
        require(not rows(devices, devices.c.api_key_hash == household_hash))
        require(not rows(credentials, credentials.c.api_key_hash == device_hash))

        existing = (household, user, membership, credential, member, device)
        if any(row is not None for row in existing):
            require(all(row is not None and row["active"] for row in existing))
            require(membership["role"] == "owner")
            require(credential["user_id"] == spec.owner_user_id)
            require(member["household_id"] == spec.household_id
                    and member["linked_user_id"] == spec.owner_user_id)
            require(device["household_id"] == spec.household_id
                    and device["api_key_hash"] == device_hash)
            return "unchanged"

        session.execute(households.insert().values(
            id=spec.household_id, name=spec.household_name, active=True))
        session.execute(users.insert().values(
            id=spec.owner_user_id, display_name=spec.owner_name, active=True))
        session.execute(memberships.insert().values(
            household_id=spec.household_id, user_id=spec.owner_user_id,
            role="owner", active=True))
        session.execute(credentials.insert().values(
            api_key_hash=household_hash, user_id=spec.owner_user_id, active=True))
        session.execute(members.insert().values(
            id=spec.member_id, household_id=spec.household_id,
            display_name=spec.member_name, linked_user_id=spec.owner_user_id, active=True))
        session.execute(devices.insert().values(
            device_id=spec.device_id, household_id=spec.household_id,
            api_key_hash=device_hash, active=True))
    return "created"


def guarded_database_url(environ: Mapping[str, str]) -> URL:
    if environ.get("POOPSENSE_APP_ENV") != "demo":
        raise BootstrapError("EXPLICIT_DEMO_ENVIRONMENT_REQUIRED")
    raw_url = environ.get("POOPSENSE_DATABASE_URL", "")
    if not raw_url:
        raise BootstrapError("EXPLICIT_POSTGRESQL_URL_REQUIRED")
    try:
        url = make_url(raw_url)
    except (ValueError, SQLAlchemyError):
        raise BootstrapError("EXPLICIT_POSTGRESQL_URL_REQUIRED") from None
    if url.drivername not in {"postgresql", "postgresql+psycopg"}:
        raise BootstrapError("POSTGRESQL_PSYCOPG_URL_REQUIRED")
    if not url.database:
        raise BootstrapError("POSTGRESQL_DATABASE_NAME_REQUIRED")
    return url.set(drivername="postgresql+psycopg")


def read_key(environ: Mapping[str, str], variable: str, prompt: str) -> str:
    if variable in environ:
        return environ[variable]
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            return getpass.getpass(prompt)
    except (getpass.GetPassWarning, EOFError, KeyboardInterrupt):
        raise BootstrapError("HIDDEN_KEY_INPUT_UNAVAILABLE") from None


class SafeArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        # argparse's usual error includes unknown arguments, which could contain
        # a key mistakenly pasted after an unsupported --device-key flag.
        raise BootstrapError("INVALID_ARGUMENTS_USE_HELP_KEYS_ARE_NOT_CLI_ARGUMENTS")


def main(argv: Sequence[str] | None = None, *, environ: Mapping[str, str] | None = None) -> int:
    parser = SafeArgumentParser(description=__doc__, allow_abbrev=False)
    for name in ("household-id", "owner-user-id", "member-id", "device-id"):
        parser.add_argument(f"--{name}", required=True)
    parser.add_argument("--household-name", default="Hardware test household")
    parser.add_argument("--owner-name", default="Test owner")
    parser.add_argument("--member-name", default="Test member")
    engine = None
    try:
        args = parser.parse_args(argv)
        environment = os.environ if environ is None else environ
        url = guarded_database_url(environment)
        device_key = read_key(environment, "POOPSENSE_TEST_DEVICE_KEY", "Private test device key: ")
        household_key = read_key(environment, "POOPSENSE_TEST_HOUSEHOLD_KEY", "Private test household key: ")
        spec = WorkspaceSpec(**vars(args))
        validate_inputs(spec, device_key, household_key)
        heads = migration_heads()
        engine = create_engine(url, hide_parameters=True, echo=False,
                               connect_args={"connect_timeout": 10})
        with Session(engine) as session:
            status = bootstrap_workspace(session, spec, device_key, household_key,
                                         expected_revisions=heads)
        print(json.dumps({"status": status, "scope": "test_demo",
                          "household_id": spec.household_id, "owner_user_id": spec.owner_user_id,
                          "member_id": spec.member_id, "device_id": spec.device_id}))
        return 0
    except BootstrapError as exc:
        print(f"Test workspace initialization refused: {exc}", file=sys.stderr)
    except (SQLAlchemyError, OSError):
        print("Test workspace initialization failed: DATABASE_OPERATION_FAILED", file=sys.stderr)
    except ImportError:
        print("Test workspace initialization failed: DATABASE_DRIVER_UNAVAILABLE", file=sys.stderr)
    finally:
        if engine is not None:
            engine.dispose()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
