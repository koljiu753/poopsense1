"""Real PostgreSQL CI check in a disposable schema, never a cloud data migration.

Requires POOPSENSE_POSTGRES_TEST_URL pointing at localhost/poopsense_ci.
Uses synthetic records only, disables model HTTP, and drops only its own schema.
"""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import ipaddress
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
from threading import Barrier
import uuid

from sqlalchemy import create_engine, event, func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session
from sqlalchemy.schema import CreateSchema, DropSchema

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def configure(url):
    for key in list(os.environ):
        if key.startswith('POOPSENSE_') or key in ('DEEPSEEK_API_KEY', 'BAICHUAN_API_KEY'):
            os.environ.pop(key, None)
    os.environ.update(
        POOPSENSE_DATABASE_URL=url,
        POOPSENSE_APP_ENV='demo',
        POOPSENSE_AUTO_CREATE_SCHEMA='false',
        POOPSENSE_BOOTSTRAP_DEMO_DEVICE='false',
        POOPSENSE_BOOTSTRAP_DEMO_DATA='false',
        POOPSENSE_INLINE_WORKER_ENABLED='false',
        POOPSENSE_LLM_PROACTIVE_ENABLED='false',
        POOPSENSE_LLM_API_KEY='',
        POOPSENSE_LLM_ROUTING_ENABLED='false',
        DEEPSEEK_API_KEY='', BAICHUAN_API_KEY='',
    )
    # Explicitly avoid loading developer credentials, including in child checks.
    original_read = Path.read_text

    def read_without_credentials(path, *args, **kwargs):
        if path.resolve() == ROOT / '.env.local':
            return ''
        return original_read(path, *args, **kwargs)

    Path.read_text = read_without_credentials
    import httpx

    def deny_external_http(*args, **kwargs):
        raise RuntimeError('Provider HTTP is disabled in PostgreSQL verification')

    httpx.HTTPTransport.handle_request = deny_external_http


def child_read():
    configure(os.environ['POOPSENSE_DATABASE_URL'])
    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app) as client:
        response = client.get('/api/v1/households/hh_001/members/m_001/sessions',
                              headers={'X-Household-Key': 'household-secret'})
        assert response.status_code == 200
        row = next(r for r in response.json() if r['session_id'] == 'ci_persisted')
        assert row['data_kind'] == 'hardware_test'
    print('Fresh application process read the claimed test record.', flush=True)


def main():
    if sys.argv[1:] == ['--child-read']:
        child_read()
        return
    url = make_url(os.environ['POOPSENSE_POSTGRES_TEST_URL'])
    container = os.environ.get('POOPSENSE_POSTGRES_TEST_CONTAINER', '')
    if (url.drivername != 'postgresql+psycopg' or url.host not in ('127.0.0.1', 'localhost', '::1')
            or url.database != 'poopsense_ci' or url.query):
        raise SystemExit('This check only accepts a local PostgreSQL database named poopsense_ci.')
    # libpq query parameters and service/host environment variables must not
    # redirect this destructive test-schema check to another database.
    for key in list(os.environ):
        if key.startswith('PG'):
            os.environ.pop(key, None)
    admin = create_engine(url, isolation_level='AUTOCOMMIT', connect_args={'connect_timeout': 10})
    schema = 'poopsense_verify_' + uuid.uuid4().hex
    assert schema.startswith('poopsense_verify_') and schema.isidentifier()
    with admin.connect() as connection:
        database, address = connection.execute(text('SELECT current_database(), inet_server_addr()::text')).one()
        # Docker's published localhost port reaches its private bridge address.
        server_address = ipaddress.ip_interface(address).ip
        assert database == 'poopsense_ci' and server_address.is_private and not server_address.is_unspecified, 'Unexpected database target'
        connection.execute(CreateSchema(schema))
    target = url.update_query_dict({'options': '-csearch_path=' + schema + ' -cstatement_timeout=30000 -clock_timeout=15000'})
    configure(target.render_as_string(hide_password=False))
    os.chdir(ROOT)
    engine = None
    try:
        from alembic import command
        from alembic.config import Config
        command.upgrade(Config(str(ROOT / 'alembic.ini')), 'head')
        from fastapi import HTTPException
        from fastapi.testclient import TestClient
        from app import main as application
        from app.database import engine, SessionLocal
        from app.models import Observation, OutboxEvent, SessionRecord
        from app.schemas import DeviceSessionInput
        from app.service import ingest
        from scripts.bootstrap_test_workspace import WorkspaceSpec, bootstrap_workspace

        private_device_key = secrets.token_urlsafe(32)
        private_household_key = secrets.token_urlsafe(32)
        workspace = WorkspaceSpec('hh_ci_private', 'u_ci_private', 'm_ci_private', 'dev_ci_private')
        with SessionLocal() as db:
            assert bootstrap_workspace(db, workspace, private_device_key, private_household_key) == 'created'
            assert bootstrap_workspace(db, workspace, private_device_key, private_household_key) == 'unchanged'

        # Only this isolated check seeds the existing synthetic demo identity.
        application.settings = replace(application.settings, bootstrap_demo_device=True)
        started = datetime.now(timezone.utc) - timedelta(minutes=2)
        payload = {
            'schema_version': '1.0', 'session_id': 'ci_persisted', 'correlation_id': 'cor_ci_persisted',
            'device_id': 'dev_001', 'household_id': 'hh_001', 'firmware_version': 'ci-only',
            'model_version': 'ci-only', 'sequence_number': 1, 'source': 'device',
            'data_kind': 'hardware_test', 'timestamp': started.isoformat(),
            'end_timestamp': (started + timedelta(seconds=10)).isoformat(), 'duration_s': 10,
            'clock_status': 'unknown', 'presence_state': 'unknown', 'collection_state': 'partial',
            'quality': {'overall_confidence': 0, 'reasons': ['synthetic_transport_test']},
            'member_candidates': [],
            'observations': {kind: {'value': None, 'confidence': None, 'source': 'adapter',
                'missing_reason': 'synthetic_transport_test', 'model_version': 'ci-only'}
                for kind in ('shape', 'color', 'odor')},
        }
        with TestClient(application.app) as client:
            device_headers = {'X-Device-Key': 'dev-secret'}
            household_headers = {'X-Household-Key': 'household-secret'}
            first = client.post('/api/v1/device-sessions', json=payload, headers=device_headers)
            assert first.status_code == 202 and not first.json()['duplicate'], first.text
            assert first.json()['data_kind'] == 'hardware_test'
            duplicate = client.post('/api/v1/device-sessions', json=payload, headers=device_headers)
            assert duplicate.status_code == 202 and duplicate.json()['duplicate'], duplicate.text
            changed = deepcopy(payload)
            changed['data_kind'] = 'simulated'
            conflict = client.post('/api/v1/device-sessions', json=changed, headers=device_headers)
            assert conflict.status_code == 409
            inbox = client.get('/api/v1/households/hh_001/claim-inbox', headers=household_headers)
            assert inbox.status_code == 200
            assert any(r['session_id'] == 'ci_persisted' and r['data_kind'] == 'hardware_test' for r in inbox.json())
            claim = client.post('/api/v1/households/hh_001/sessions/ci_persisted/claim',
                                headers=household_headers, json={'member_id': 'm_001'})
            assert claim.status_code == 200, claim.text
            private_payload = deepcopy(payload)
            private_payload.update(session_id='ci_private', correlation_id='cor_ci_private',
                                   device_id=workspace.device_id, household_id=workspace.household_id)
            private_response = client.post('/api/v1/device-sessions', json=private_payload,
                                           headers={'X-Device-Key': private_device_key})
            assert private_response.status_code == 202, private_response.text
            private_inbox = '/api/v1/households/hh_ci_private/claim-inbox'
            assert client.get(private_inbox, headers=household_headers).status_code == 403
            visible = client.get(private_inbox, headers={'X-Household-Key': private_household_key})
            assert visible.status_code == 200 and len(visible.json()) == 1
        application.settings = replace(application.settings, bootstrap_demo_device=False)
        engine.dispose()
        subprocess.run([sys.executable, str(Path(__file__).resolve()), '--child-read'], check=True, timeout=60)

        def race(identifier, differing):
            rendezvous = Barrier(2)

            def before_flush(session, flush_context, instances):
                if any(isinstance(row, SessionRecord) and row.external_session_id == identifier for row in session.new):
                    rendezvous.wait(timeout=20)

            def upload(index):
                item = deepcopy(payload)
                item.update(session_id=identifier, correlation_id='cor_' + identifier)
                if differing and index:
                    item['data_kind'] = 'simulated'
                with SessionLocal() as db:
                    try:
                        result = ingest(db, DeviceSessionInput.model_validate(item), 'dev-secret')
                        return {'code': 202, 'duplicate': result[3]}
                    except HTTPException as error:
                        return {'code': error.status_code}

            event.listen(Session, 'before_flush', before_flush)
            try:
                with ThreadPoolExecutor(max_workers=2) as executor:
                    results = list(executor.map(upload, (0, 1)))
            finally:
                event.remove(Session, 'before_flush', before_flush)
            if differing:
                assert sorted(row['code'] for row in results) == [202, 409], results
            else:
                assert all(row['code'] == 202 for row in results), results
                assert sorted(row['duplicate'] for row in results) == [False, True], results
            with SessionLocal() as db:
                records = db.scalars(select(SessionRecord).where(SessionRecord.external_session_id == identifier)).all()
                assert len(records) == 1
                assert db.scalar(select(func.count()).select_from(Observation).where(Observation.session_id == records[0].id)) == 3
                assert db.scalar(select(func.count()).select_from(OutboxEvent).where(
                    OutboxEvent.idempotency_key == 'session.received:dev_001:' + identifier)) == 1
            return results

        same = race('ci_same_race', False)
        different = race('ci_conflict_race', True)
        from scripts.verify_postgres_backup import verify_backup_restore
        backup = verify_backup_restore(admin, engine, schema, container) if container else {'status': 'not_run'}
        print(json.dumps({'postgres_migrations': 'passed', 'upload_claim_fresh_process': 'passed',
                          'same_payload_race': same, 'different_payload_race': different,
                          'backup_restore': backup}), flush=True)
    finally:
        if engine is not None:
            engine.dispose()
        with admin.connect() as connection:
            connection.execute(DropSchema(schema, cascade=True))
        admin.dispose()


if __name__ == '__main__':
    main()
