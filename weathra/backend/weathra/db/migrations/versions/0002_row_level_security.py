"""row level security on user-owned tables, and the restricted request role

The second of the two gates in design.md decision 5. The first is the ownership predicate every
repository applies; this one is the database's own. A handler that forgets ``AND user_id = :actor``
then returns *nothing* instead of another user's row.

Three pieces make that work:

1. **``weathra_current_user_id()``** reads the acting user's subject out of the
   ``request.jwt.claims`` setting the request-scoped session sets. Deliberately not Supabase's
   ``auth.uid()``: a policy depending on Supabase's own schema could not be tested against a plain
   Postgres, and the whole point of the RLS test is that it runs in CI.
2. **The ``weathra_request`` role.** The backend's own connection would ordinarily bypass RLS,
   because a table's owner is exempt. Each request assumes this non-privileged, ``NOLOGIN`` role
   inside its transaction, so the policies apply to backend queries too.
3. **The policies themselves**, one per user-owned table, restricting every command to rows the
   acting user owns — with ``WITH CHECK`` as well as ``USING``, so a write cannot create or move a
   row into someone else's ownership.

Shared tables are left unrestricted on purpose, consistent with their documented classification:
``forecast_snapshots`` is location-keyed and carries no user reference, and the knowledge corpus is
readable by anyone. ``specs/authentication`` requires exactly that asymmetry, and the test asserts
policies are *absent* there as well as present on the user-owned tables.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0002_row_level_security"
down_revision: str | None = "0001_initial_schema"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Must match Settings.database_restricted_role.
RESTRICTED_ROLE = "weathra_request"

# Must match weathra.db.models.user_owned_tables(). A test asserts the two agree.
USER_OWNED_TABLES = (
    "profiles",
    "preferences",
    "saved_locations",
    "threads",
    "agent_runs",
)

# Tables the restricted role may read but never write.
SHARED_READ_ONLY_TABLES = (
    "knowledge_documents",
    "knowledge_chunks",
)

# Location-keyed and shared: the request path both reads and appends snapshots, and there is no
# ownership to restrict because a snapshot has no owner.
SHARED_APPEND_TABLES = ("forecast_snapshots",)


def upgrade() -> None:
    # ------------------------------------------------------------------ the claims accessor
    op.execute(
        """
        CREATE OR REPLACE FUNCTION weathra_current_user_id() RETURNS text
        LANGUAGE sql STABLE
        AS $$
            -- The setting is unset on a fresh connection and empty when a session binds no
            -- principal. Both must read as "owns nothing", so they are coalesced to an empty
            -- object rather than cast straight to jsonb, which would raise on ''.
            SELECT nullif(
                coalesce(
                    nullif(current_setting('request.jwt.claims', true), ''),
                    '{}'
                )::jsonb ->> 'sub',
                ''
            )
        $$
        """
    )
    op.execute(
        "COMMENT ON FUNCTION weathra_current_user_id() IS "
        "'The acting user''s auth subject, from the claims the request-scoped session sets. "
        "Returns NULL when no principal is bound, which every policy treats as owning nothing.'"
    )

    # ------------------------------------------------------------------ the restricted role
    op.execute(
        f"""
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{RESTRICTED_ROLE}') THEN
                CREATE ROLE {RESTRICTED_ROLE} NOLOGIN NOBYPASSRLS;
            END IF;
        END
        $$
        """
    )
    op.execute(f"GRANT USAGE ON SCHEMA public TO {RESTRICTED_ROLE}")
    op.execute(f"GRANT EXECUTE ON FUNCTION weathra_current_user_id() TO {RESTRICTED_ROLE}")

    for table in USER_OWNED_TABLES:
        op.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO {RESTRICTED_ROLE}")
    for table in SHARED_READ_ONLY_TABLES:
        op.execute(f"GRANT SELECT ON {table} TO {RESTRICTED_ROLE}")
    for table in SHARED_APPEND_TABLES:
        op.execute(f"GRANT SELECT, INSERT ON {table} TO {RESTRICTED_ROLE}")

    # ------------------------------------------------------------------ the policies
    for table in USER_OWNED_TABLES:
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        # FORCE so the policies bind even when the connected user happens to own the table, which
        # is the case on a managed Postgres where migrations and requests share a database user.
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(
            f"""
            CREATE POLICY {table}_owner_only ON {table}
            FOR ALL
            USING (user_id::text = weathra_current_user_id())
            WITH CHECK (user_id::text = weathra_current_user_id())
            """
        )


def downgrade() -> None:
    for table in USER_OWNED_TABLES:
        op.execute(f"DROP POLICY IF EXISTS {table}_owner_only ON {table}")
        op.execute(f"ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")
        op.execute(f"REVOKE ALL ON {table} FROM {RESTRICTED_ROLE}")

    for table in SHARED_READ_ONLY_TABLES + SHARED_APPEND_TABLES:
        op.execute(f"REVOKE ALL ON {table} FROM {RESTRICTED_ROLE}")

    op.execute(f"REVOKE EXECUTE ON FUNCTION weathra_current_user_id() FROM {RESTRICTED_ROLE}")
    op.execute(f"REVOKE USAGE ON SCHEMA public FROM {RESTRICTED_ROLE}")
    # The role is left in place: it is cluster-scoped and may own grants in other databases, so
    # dropping it from one database's migration would be reaching outside this migration's scope.
    op.execute("DROP FUNCTION IF EXISTS weathra_current_user_id()")
