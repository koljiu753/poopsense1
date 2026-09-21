"""Dump and restore the isolated PostgreSQL CI schema using its service container.

This helper cannot target cloud databases. It restores into a newly created,
random database on the same local CI server and never overwrites source data.
"""
from hashlib import sha256
import json
import re
import subprocess
import uuid

from sqlalchemy import MetaData, Table, create_engine, inspect, select, text


def snapshot(engine, schema):
    with engine.connect() as connection:
        tables = inspect(connection).get_table_names(schema=schema)
        result = {}
        for name in sorted(tables):
            table = Table(name, MetaData(), schema=schema, autoload_with=connection)
            rows = [json.dumps(dict(row), sort_keys=True, default=str)
                    for row in connection.execute(select(table)).mappings()]
            result[name] = {'rows': len(rows), 'sha256': sha256(
                '\n'.join(sorted(rows)).encode()).hexdigest()}
        return result


def verify_backup_restore(admin, source, schema, container):
    url = admin.url
    if (url.host not in ('localhost', '127.0.0.1', '::1')
            or url.database != 'poopsense_ci' or url.query
            or not re.fullmatch(r'[a-f0-9]{12,64}', container)
            or not re.fullmatch(r'poopsense_verify_[a-f0-9]{32}', schema)):
        raise RuntimeError('Backup verification requires the isolated CI service.')
    restore_name = 'poopsense_restore_' + uuid.uuid4().hex
    assert restore_name.isidentifier()
    before = snapshot(source, schema)
    # The CI container has only synthetic fixtures and uses its local Unix socket.
    dump = subprocess.run(['docker', 'exec', container, 'pg_dump', '-U', 'poopsense_ci',
                           '-d', 'poopsense_ci', '--schema', schema, '--format=custom',
                           '--no-owner'], capture_output=True, timeout=60)
    if dump.returncode or not dump.stdout.startswith(b'PGDMP'):
        raise RuntimeError('CI database backup failed.')
    restored = None
    created = False
    try:
        with admin.connect() as connection:
            connection.execute(text('CREATE DATABASE ' + restore_name))
            created = True
        restore = subprocess.run(['docker', 'exec', '-i', container, 'pg_restore',
                                  '-U', 'poopsense_ci', '-d', restore_name,
                                  '--exit-on-error', '--no-owner'], input=dump.stdout,
                                 capture_output=True, timeout=60)
        if restore.returncode:
            raise RuntimeError('CI database restore failed.')
        restored = create_engine(url.set(database=restore_name),
                                 connect_args={'connect_timeout': 10})
        after = snapshot(restored, schema)
        assert before == after, 'Restored table contents differ from the source.'
        assert before['sessions']['rows'] > 0
        return {'status': 'passed', 'tables': len(before), 'backup_bytes': len(dump.stdout),
                'method': 'pg_dump_custom_pg_restore_into_separate_database'}
    finally:
        if restored is not None:
            restored.dispose()
        if created:
            with admin.connect() as connection:
                connection.execute(text('DROP DATABASE ' + restore_name))
