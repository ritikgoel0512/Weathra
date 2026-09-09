"""the administrative role as a row, and the accessor that stops reading a claim

``specs/authentication`` requires the administrative role to be "held as backend state keyed by the
validated token subject", and requires "an unverified token claim asserting the role" to be
ignored. Groups 28 to 30 read it from the validated token's ``app_metadata`` — server-controlled at
Supabase, and a reasonable stand-in while there was no state to read from. This is the state, and
after this revision the claim contributes nothing anywhere.

**Why the change is worth a migration rather than a shrug.** A claim travels with the caller. A row
does not. Everything that can go wrong with an identity provider — a project's metadata copied
between environments, a token minted by a compromised project, a mapping rule that widens by
accident — promotes somebody under the claim model and promotes nobody under this one. The
authority becomes a table Weathra owns, written only on the privileged connection, and every write
lands in ``admin_audit``.

**The request role may read its own row and nothing else.** The predicate runs on the request path
— the quota gate asks it, the resolver asks it, the administrative dependency asks it — so making
it a privileged read would put the privileged connection on the normal request path, which is
exactly what design.md decision 5 forbids. So: ``SELECT`` granted, an owner-only policy, and no
write grant of any kind. A caller can discover whether *they* are an administrator; they can learn
nothing about anyone else and can write nothing.

**``weathra_is_administrative()`` becomes ``SECURITY DEFINER``, deliberately.** The policy on
``usage_counters`` that ``0010`` added calls it, and it now reads ``admin_roles`` — a table with a
policy of its own. Left ``INVOKER`` it would be evaluated under the caller's policies, which is
both circular in shape and fragile. ``DEFINER`` with a pinned ``search_path`` is the standard way to
write a policy helper: the function takes no arguments, reads only the *current session's* subject,
and returns a boolean, so there is nothing a caller can steer it with.

Revision ID: 0011_administrative_role_state
Revises: 0010_internal_quota_accounting
Create date: 2026-09-09
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0011_administrative_role_state"
down_revision: str | None = "0010_internal_quota_accounting"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Must match 0002's RESTRICTED_ROLE and Settings.database_restricted_role.
RESTRICTED_ROLE = "weathra_request"
CURRENT_USER = "weathra_current_user_id()"

# Must match `auth/roles.py`'s ADMINISTRATOR_ROLE.
ADMINISTRATOR_ROLE = "administrator"

# The claim container and name 0010's accessor used to read. Named here only so the downgrade can
# put the old definition back exactly, rather than approximately.
ROLE_CLAIM = "weathra_role"
CLAIM_CONTAINER = "app_metadata"

_ROW_ACCESSOR = f"""
CREATE OR REPLACE FUNCTION weathra_is_administrative() RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.admin_roles
         WHERE role = '{ADMINISTRATOR_ROLE}'
           AND subject_id::text = {CURRENT_USER}
    )
$$
"""

# 0010's definition, restored verbatim by the downgrade so a rollback lands on the behaviour that
# revision actually shipped rather than on an approximation of it.
_CLAIM_ACCESSOR = f"""
CREATE OR REPLACE FUNCTION weathra_is_administrative() RETURNS boolean
LANGUAGE sql STABLE
AS $$
    WITH claims AS (
        SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{{}}')::jsonb
               AS payload
    ),
    declared AS (
        SELECT value
          FROM claims,
               LATERAL (VALUES (payload -> '{ROLE_CLAIM}'),
                               (payload -> '{CLAIM_CONTAINER}' -> '{ROLE_CLAIM}')) AS c(value)
    ),
    roles AS (
        SELECT jsonb_array_elements_text(value) AS role_name
          FROM declared WHERE jsonb_typeof(value) = 'array'
        UNION ALL
        SELECT value #>> '{{}}' FROM declared WHERE jsonb_typeof(value) = 'string'
    )
    SELECT coalesce(bool_or(btrim(lower(role_name)) = '{ADMINISTRATOR_ROLE}'), false) FROM roles
$$
"""


def upgrade() -> None:
    op.create_table(
        "admin_roles",
        sa.Column("subject_id", sa.dialects.postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("role", sa.String(32), nullable=False),
        sa.Column("granted_by", sa.dialects.postgresql.UUID(as_uuid=False), nullable=True),
        sa.Column(
            "granted_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("length(role) > 0", name="ck_admin_roles_role_present"),
        sa.PrimaryKeyConstraint("subject_id", "role"),
    )
    op.create_index("ix_admin_roles_role", "admin_roles", ["role"])

    op.execute("ALTER TABLE admin_roles ENABLE ROW LEVEL SECURITY")
    # FORCE for 0002's reason: on a managed Postgres the migration and request credentials can be
    # the same database user, and a table's owner is otherwise exempt from its own policies.
    op.execute("ALTER TABLE admin_roles FORCE ROW LEVEL SECURITY")

    # Read your own row. No INSERT, UPDATE or DELETE is granted to anybody on the request path —
    # a self-service administrative grant is the one write this table must make impossible.
    op.execute(f"GRANT SELECT ON admin_roles TO {RESTRICTED_ROLE}")
    op.execute(
        f"""
        CREATE POLICY admin_roles_owner_read ON admin_roles
        FOR SELECT
        TO {RESTRICTED_ROLE}
        USING (subject_id::text = {CURRENT_USER})
        """
    )

    op.execute(_ROW_ACCESSOR)
    op.execute(
        "COMMENT ON FUNCTION weathra_is_administrative() IS "
        "'Whether the acting session''s subject holds the administrative role in admin_roles. "
        "Backend state, never a token claim. False for an unbound session.'"
    )


def downgrade() -> None:
    op.execute(_CLAIM_ACCESSOR)
    op.execute("DROP POLICY IF EXISTS admin_roles_owner_read ON admin_roles")
    op.drop_index("ix_admin_roles_role", table_name="admin_roles")
    op.drop_table("admin_roles")
