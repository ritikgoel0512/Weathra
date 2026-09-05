"""the login identity the request-serving connection authenticates as

``0002`` created ``weathra_request`` as ``NOLOGIN``, because a role that is *assumed* inside a
transaction must not also be a role anything can connect as. That left a question it did not
answer: which role, then, does ``DATABASE_URL`` authenticate as before it runs ``SET LOCAL ROLE``?

Nothing answered it, and CI did not notice — its privileged and request URLs are the same
``postgres`` superuser, so the role switch always succeeded and the missing membership was never
exercised. On a real project that silence resolves into the worst available answer: pointing
``DATABASE_URL`` at the owner, which would make the request-serving credential and the migration
credential the same secret and give a leaked ``DATABASE_URL`` schema access and RLS bypass.

So this migration adds the missing third role, and only the third role:

* **``weathra_api``** — ``LOGIN``, and nothing else. No table privileges, no ownership, no
  ``CREATEDB``/``CREATEROLE``/``REPLICATION``/``SUPERUSER``, and ``NOBYPASSRLS``.
* **``NOINHERIT`` is the load-bearing attribute.** Membership in ``weathra_request`` would
  otherwise apply automatically to every query, which would make the ``SET LOCAL ROLE`` in
  ``db/session.py`` decorative. With ``NOINHERIT`` the membership confers exactly one capability —
  the right to *become* ``weathra_request`` — so a request that somehow skipped the role switch
  runs as a role that can read nothing, rather than as one that can read everything.

The result is three roles across two connections, which is what makes ``DATABASE_URL`` genuinely
non-privileged rather than privileged-but-well-behaved:

    postgres        DATABASE_URL_PRIVILEGED, direct connection. Migrations and admin routines.
    weathra_api     DATABASE_URL, pooler. Can log in and become weathra_request. Nothing else.
    weathra_request assumed per transaction. The role the RLS policies are written against.

**No password appears here, and none ever should.** A role created ``LOGIN`` with no password
cannot authenticate under SCRAM, so ``weathra_api`` is inert until a deployment sets its credential
out of band (``ALTER ROLE weathra_api PASSWORD …``) and puts the resulting URL in secret storage.
That split is the point: this file is committed and must stay readable to anyone, while the
credential belongs to the deployment. ``ALTER ROLE`` on attributes does not disturb an already-set
password, so re-running this migration after provisioning is safe.

**The migration administrator is not assumed to be a superuser.** A managed Postgres deliberately
withholds that: Supabase's ``postgres`` has ``CREATEROLE``, ``CREATEDB`` and ``BYPASSRLS`` but is
not a superuser and has no ``REPLICATION``. PostgreSQL lets a non-superuser change ``SUPERUSER``,
``REPLICATION``, ``BYPASSRLS`` or ``CREATEDB`` on another role only if it holds that attribute
itself, in either direction — so re-asserting ``NOSUPERUSER NOREPLICATION`` on a role that already
has neither is refused, and the whole statement fails. The corrective ``ALTER ROLE`` therefore names
only the clauses the current role may actually change, and a check afterwards raises if the role is
left holding anything the design forbids. CI runs as a superuser, which is why this was invisible
until the first real Supabase migration.

Revision ID: 0003_request_login_role
Revises: 0002_row_level_security
Create date: 2026-09-05
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0003_request_login_role"
down_revision: str | None = "0002_row_level_security"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Must match Settings.database_restricted_role, and the role 0002 creates.
RESTRICTED_ROLE = "weathra_request"

# The login identity DATABASE_URL authenticates as. Not configuration: the grant below is what
# makes the role switch possible at all, so the two names have to agree in one place.
LOGIN_ROLE = "weathra_api"

# Spelled out rather than left to the defaults, so the intent is auditable in the migration itself
# instead of in whatever the server's defaults happened to be. NOINHERIT is the one that matters.
LOGIN_ROLE_ATTRIBUTES = (
    "LOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION"
)

# The four attributes PostgreSQL will not let an administrator change unless it holds that same
# attribute — SUPERUSER requiring an actual superuser — and it applies in *both* directions: naming
# `NOREPLICATION` on a role that is already NOREPLICATION is still refused. They are fine in
# `CREATE ROLE`, which is why the creation path below keeps the full list; only re-asserting them
# on an existing role is gated.
GATED_ATTRIBUTES = ("SUPERUSER", "REPLICATION", "BYPASSRLS", "CREATEDB")

# The remainder — LOGIN, NOINHERIT, NOCREATEROLE — which any role that may alter this one at all
# can always assert. Derived rather than written out a second time, so the two cannot drift apart.
UNGATED_ATTRIBUTES = " ".join(
    attribute
    for attribute in LOGIN_ROLE_ATTRIBUTES.split()
    if attribute.removeprefix("NO") not in GATED_ATTRIBUTES
)


def upgrade() -> None:
    # Created only if absent, like 0002's role: an environment may already have it, and a
    # migration that failed on a role someone provisioned by hand would be worse than useless.
    op.execute(
        f"""
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{LOGIN_ROLE}') THEN
                CREATE ROLE {LOGIN_ROLE} {LOGIN_ROLE_ATTRIBUTES};
            END IF;
        END
        $$
        """
    )
    # Re-asserted afterwards, because the branch above skips an existing role and a role that
    # exists with the wrong attributes is exactly the case worth correcting.
    #
    # Which clauses may be named is a property of the administrator running the migration, not of
    # this file, so they are chosen at runtime. A managed platform's migration role is deliberately
    # not a superuser — Supabase's `postgres` holds CREATEROLE, CREATEDB and BYPASSRLS but neither
    # SUPERUSER nor REPLICATION — and the fixed list this once ran was rejected outright there,
    # before any of it took effect. Naming only what the current role may change keeps every
    # attribute it *can* correct enforced, and the check below covers the rest.
    #
    # No PASSWORD clause appears, so an already-provisioned credential is left undisturbed.
    op.execute(
        f"""
        DO $$
        DECLARE
            migration_admin record;
            clauses text := '{UNGATED_ATTRIBUTES}';
        BEGIN
            SELECT rolsuper, rolreplication, rolbypassrls, rolcreatedb
              INTO migration_admin
              FROM pg_roles
             WHERE rolname = current_user;

            IF migration_admin.rolsuper THEN
                clauses := clauses || ' NOSUPERUSER';
            END IF;
            IF migration_admin.rolsuper OR migration_admin.rolreplication THEN
                clauses := clauses || ' NOREPLICATION';
            END IF;
            IF migration_admin.rolsuper OR migration_admin.rolbypassrls THEN
                clauses := clauses || ' NOBYPASSRLS';
            END IF;
            IF migration_admin.rolsuper OR migration_admin.rolcreatedb THEN
                clauses := clauses || ' NOCREATEDB';
            END IF;

            EXECUTE format('ALTER ROLE %I %s', '{LOGIN_ROLE}', clauses);
        END
        $$
        """
    )

    # The guarantee the statement above can no longer make on its own. Every attribute it may have
    # had to skip is checked here against what the role actually is, so a role left over-privileged
    # on a platform that would not let the migration correct it stops the migration loudly instead
    # of quietly becoming the identity that serves requests. This is strictly stronger than the
    # unconditional ALTER it replaces, which asserted the attributes and then never looked.
    op.execute(
        f"""
        DO $$
        DECLARE
            login_role record;
        BEGIN
            SELECT rolcanlogin, rolinherit, rolbypassrls, rolsuper,
                   rolcreatedb, rolcreaterole, rolreplication
              INTO login_role
              FROM pg_roles
             WHERE rolname = '{LOGIN_ROLE}';

            IF NOT login_role.rolcanlogin
               OR login_role.rolinherit
               OR login_role.rolbypassrls
               OR login_role.rolsuper
               OR login_role.rolcreatedb
               OR login_role.rolcreaterole
               OR login_role.rolreplication
            THEN
                RAISE EXCEPTION
                    'role {LOGIN_ROLE} must be LOGIN NOINHERIT and hold no other attribute, but is '
                    'login=% inherit=% bypassrls=% superuser=% '
                    'createdb=% createrole=% replication=%. '
                    'A superuser must correct it before this migration can run.',
                    login_role.rolcanlogin, login_role.rolinherit, login_role.rolbypassrls,
                    login_role.rolsuper, login_role.rolcreatedb, login_role.rolcreaterole,
                    login_role.rolreplication;
            END IF;
        END
        $$
        """
    )

    # Explicit rather than relying on PUBLIC's default CONNECT: a project that has hardened its
    # database by revoking it would otherwise leave this role able to authenticate and unable to
    # connect, which reads as a credential problem and is not one.
    op.execute(
        f"""
        DO $$
        BEGIN
            EXECUTE format('GRANT CONNECT ON DATABASE %I TO {LOGIN_ROLE}', current_database());
        END
        $$
        """
    )

    # The whole point of the role. Idempotent: re-granting an existing membership is a no-op.
    op.execute(f"GRANT {RESTRICTED_ROLE} TO {LOGIN_ROLE}")


def downgrade() -> None:
    # Only what this migration granted. `weathra_request` itself belongs to 0002 and is left
    # exactly as that migration made it — reaching into it from here would mean this downgrade
    # could break the role its own upgrade depends on.
    op.execute(f"REVOKE {RESTRICTED_ROLE} FROM {LOGIN_ROLE}")
    op.execute(
        f"""
        DO $$
        BEGIN
            EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM {LOGIN_ROLE}', current_database());
        END
        $$
        """
    )
    # The role is left in place, for 0002's reason and one more of its own: it is cluster-scoped,
    # and by the time anything downgrades it may hold a provisioned credential that a deployment's
    # secret storage still refers to. Dropping it here would break that from inside one database.
