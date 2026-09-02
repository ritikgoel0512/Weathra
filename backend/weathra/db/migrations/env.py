"""Alembic environment.

Migrations run under the **privileged** connection (design.md decision 5): they create the schema,
enable ``pgvector``, and establish the Row Level Security policies, none of which the restricted
request-serving role may do. The URL comes from the environment through ``weathra.config`` so no
privileged credential is stored in ``alembic.ini``.

Alembic is synchronous, so the configured URL — whatever driver it names — is rewritten to
``postgresql+psycopg`` for the duration of the migration.
"""

from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from weathra.config import Settings
from weathra.db.models import Base
from weathra.db.urls import ConnectionRole, resolve_url, sync_url

config = context.config

if config.config_file_name is not None:
    # `disable_existing_loggers=False` matters more than it looks. The default is True, which
    # switches off every logger that already exists — so running a migration in-process (the
    # release step, or the `db` test suite) would silently mute the application's own loggers for
    # the rest of the process, and a warning like a failed snapshot write would vanish.
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


def _privileged_url() -> str:
    """The privileged URL, from `-x url=...` when given, otherwise from the environment."""
    override = context.get_x_argument(as_dictionary=True).get("url")
    raw = override or resolve_url(Settings(), ConnectionRole.PRIVILEGED)
    return sync_url(raw).render_as_string(hide_password=False)


def run_migrations_offline() -> None:
    """Emit SQL to stdout rather than running it — used to review a release's DDL."""
    context.configure(
        url=_privileged_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    section = config.get_section(config.config_ini_section, {})
    section["sqlalchemy.url"] = _privileged_url()

    connectable = engine_from_config(section, prefix="sqlalchemy.", poolclass=pool.NullPool)

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
