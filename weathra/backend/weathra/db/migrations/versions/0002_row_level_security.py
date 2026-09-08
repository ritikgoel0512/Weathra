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

    # ------------------------------------------------------------- policies written outside Alembic
    #
    # The accessor above is this migration's own object, but by the time anything downgrades it is
    # not the only thing calling it. `memory/checkpointer.py` writes owner-restricting policies over
    # the three LangGraph checkpoint tables — created by the library at runtime, so outside every
    # migration — and those policies test the same `weathra_current_user_id()`. PostgreSQL then
    # refuses to drop the function while they exist, and `alembic downgrade base` fails on any
    # database the application has ever started against. CI reproduces it exactly: the db-marked
    # suite provisions the checkpointer, and the downgrade step then cannot undo 0002.
    #
    # Dropping them here is not the reaching-outside-scope the role comment above declines. The
    # function is this migration's, the dependency is on the function, and the only alternatives are
    # to fail the downgrade or to `DROP ... CASCADE` — which would do exactly this, silently and
    # without naming what it took. Each policy is found through `pg_depend`, so only what actually
    # depends on the accessor is dropped, and each is named in the log as it goes.
    #
    # Row Level Security is left enabled on those tables. A table with RLS on and no policy denies
    # every row to a role that is neither its owner nor `BYPASSRLS`, which is the safe direction to
    # leave a half-torn-down database in; `provision_checkpointer` re-creates both the policies and
    # the grants on the next start, after the migrations are applied again.
    op.execute(
        """
        DO $$
        DECLARE
            accessor oid := to_regprocedure('weathra_current_user_id()');
            dependent record;
        BEGIN
            IF accessor IS NULL THEN
                RETURN;
            END IF;

            FOR dependent IN
                SELECT namespace.nspname AS schema_name,
                       relation.relname  AS table_name,
                       policy.polname    AS policy_name
                  FROM pg_policy AS policy
                  JOIN pg_class AS relation ON relation.oid = policy.polrelid
                  JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
                 WHERE EXISTS (
                           SELECT 1
                             FROM pg_depend AS dependency
                            WHERE dependency.classid = 'pg_policy'::regclass
                              AND dependency.objid = policy.oid
                              AND dependency.refclassid = 'pg_proc'::regclass
                              AND dependency.refobjid = accessor
                       )
            LOOP
                RAISE NOTICE
                    'dropping policy %.%.% , which depends on weathra_current_user_id()',
                    dependent.schema_name, dependent.table_name, dependent.policy_name;
                EXECUTE format(
                    'DROP POLICY %I ON %I.%I',
                    dependent.policy_name, dependent.schema_name, dependent.table_name
                );
            END LOOP;
        END
        $$
        """
    )
    op.execute("DROP FUNCTION IF EXISTS weathra_current_user_id()")
