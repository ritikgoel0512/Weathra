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
    # Asserted unconditionally afterwards, because the branch above skips an existing role and a
    # role that exists with the wrong attributes is exactly the case worth correcting. This does
    # not touch the password, so it is safe to run against a provisioned role.
    op.execute(f"ALTER ROLE {LOGIN_ROLE} {LOGIN_ROLE_ATTRIBUTES}")

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
