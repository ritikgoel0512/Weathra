"""administrator-gated plan assignment on the request connection

The last administrative operation that could not run where it is invoked from.
``PUT /api/v1/admin/principals/{subject_id}/plan`` is the plan-management screen's one write, and
it opened ``AdministrativeSession`` — the privileged connection, which the request-serving
container is deliberately never given
(``tests/test_secret_storage.py::test_the_render_service_never_holds_the_privileged_database_url``).
Reproduced against production-shaped settings, it fails as
``ValueError: DATABASE_URL_PRIVILEGED is not configured`` while the dependency resolves, so the
handler never runs and an administrator sees a 500 after their authorization has already succeeded.

**Why this is a function and not a policy.** ``user_plans`` is user-owned. ``0015`` gives it
self-service ``INSERT`` and ``UPDATE`` under ``WITH CHECK (user_id::text =
weathra_current_user_id())``, which is what lets a person move *themselves* between tiers and is
exactly what must not be widened: a second policy is OR-ed with the first, so an
administrator-gated ``WITH CHECK`` beside it would let *any* row be written by a caller the
predicate admits, and ``test_saas_rls.py::test_a_new_user_owned_table_carries_an_owner_policy``
refuses an administrative policy on a user-owned table outright. ``0018`` answered the same
question for the administrative *reads* and this is the same answer for the one write: a
``SECURITY DEFINER`` function that opens with ``weathra_is_administrative()`` — ``0011``'s predicate
over ``admin_roles``, which no claim, header or body field can satisfy.

**What the function may do, stated as narrowly as it is written.** One row of one table, named by
its argument, and only the three columns an assignment consists of. It cannot read a thread, a
saved location, a watch or a usage event; it cannot touch ``usage_counters`` or
``llm_usage_events``, so an assignment does not reset what a person has already consumed — a tier
is what somebody is allowed, not what they have already done, and ``specs/usage-limits`` counts
consumption per window regardless of plan. It returns the plan code the subject was on before,
because that is the ``before`` state the audit row records and reading it separately on the request
session would return null for anybody but the caller.

**The audit is unchanged.** ``entitlements/audit.py`` still writes ``admin_audit`` in the same
transaction, through the ``INSERT`` ``0017`` already grants under its own administrative policy. No
second audit model is introduced, and the function deliberately does not write the trail itself:
one place writes ``admin_audit``, which is the property that stops the next administrative write
from recording nothing.

**Nothing else changes.** No policy is created, altered or dropped; no table gains a grant. Self
service keeps ``0015``'s policies exactly, an ordinary caller still cannot write another person's
row by any route, and the privileged ``PlanStore.assign`` the bootstrap script uses is untouched.

Revision ID: 0019_admin_plan_assign
Revises: 0018_admin_aggregates

The identifier is abbreviated for ``0016``'s reason: ``alembic_version.version_num`` is
``varchar(32)``, and the upgrade fails on the version bookkeeping *after* the DDL.
Create date: 2026-09-14
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0019_admin_plan_assign"
down_revision: str | None = "0018_admin_aggregates"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Must match 0002's RESTRICTED_ROLE and Settings.database_restricted_role.
RESTRICTED_ROLE = "weathra_request"

SIGNATURE = "weathra_admin_assign_plan(text, text, text)"

_ASSIGN = """
CREATE OR REPLACE FUNCTION weathra_admin_assign_plan(
    p_subject text,
    p_plan    text,
    p_actor   text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    previous text;
BEGIN
    IF NOT public.weathra_is_administrative() THEN
        RAISE EXCEPTION 'the administrative role is required to assign another principal a plan'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT up.plan_code INTO previous
      FROM public.user_plans up
     WHERE up.user_id = CAST(p_subject AS uuid);

    -- The foreign keys still apply inside this function: an unknown plan code and a subject with
    -- no profile each raise exactly as they did on the privileged path, rather than being admitted
    -- because the caller holds the role.
    INSERT INTO public.user_plans (user_id, plan_code, assigned_by, assigned_at)
    VALUES (CAST(p_subject AS uuid), p_plan, CAST(p_actor AS uuid), now())
    ON CONFLICT (user_id) DO UPDATE
       SET plan_code   = excluded.plan_code,
           assigned_by = excluded.assigned_by,
           assigned_at = excluded.assigned_at;

    RETURN previous;
END;
$$
"""

COMMENT = (
    "Put one principal on one subscription plan, returning the plan they were on before. "
    "Writes user_plans and nothing else, so an assignment never resets what somebody has already "
    "consumed. Refuses a caller who does not hold the administrative role in admin_roles."
)


def upgrade() -> None:
    op.execute(_ASSIGN)
    # Narrower than the default. EXECUTE on a new function is granted to PUBLIC, and this one
    # writes a row its caller does not own, so the grant is stated rather than inherited.
    op.execute(f"REVOKE ALL ON FUNCTION {SIGNATURE} FROM PUBLIC")
    op.execute(f"GRANT EXECUTE ON FUNCTION {SIGNATURE} TO {RESTRICTED_ROLE}")
    op.execute(f"COMMENT ON FUNCTION {SIGNATURE} IS '{COMMENT}'")


def downgrade() -> None:
    op.execute(f"DROP FUNCTION IF EXISTS {SIGNATURE}")
