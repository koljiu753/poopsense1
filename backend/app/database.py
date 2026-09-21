from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import settings


class Base(DeclarativeBase):
    pass


if settings.database_url.startswith("sqlite"):
    engine = create_engine(settings.database_url, connect_args={"check_same_thread": False})
elif settings.database_url.startswith("postgresql+psycopg:"):
    # Recheck connections after a serverless instance sleeps. Keep each
    # instance's pool small; hosted transaction poolers own the shared pool.
    engine = create_engine(
        settings.database_url,
        connect_args={"connect_timeout": 10, "prepare_threshold": None},
        pool_pre_ping=True,
        pool_recycle=300,
        pool_size=2,
        max_overflow=2,
        pool_timeout=15,
    )
else:
    engine = create_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def get_db() -> Generator[Session, None, None]:
    with SessionLocal() as session:
        yield session
