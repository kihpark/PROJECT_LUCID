"""Alembic environment.

Reads DATABASE_URL from the env (preferred) or falls back to the
[alembic] sqlalchemy.url in alembic.ini. Uses sync engine; async
migrations come if/when we move the runtime to async.
"""
from __future__ import annotations

import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from api.storage.postgres.orm import Base

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Allow DATABASE_URL env to override the ini value.
env_url = os.getenv("DATABASE_URL")
if env_url:
    # SQLAlchemy expects "postgresql+psycopg2://..." for psycopg2 driver.
    if env_url.startswith("postgresql://"):
        env_url = "postgresql+psycopg2://" + env_url[len("postgresql://"):]
    config.set_main_option("sqlalchemy.url", env_url)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode (SQL script generation)."""
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode (against a live engine)."""
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
