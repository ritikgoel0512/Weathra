"""administrator-gated aggregate reads, as functions rather than as policies

Task 34.7's last product-quality defect. ``0016`` moved the administrative reads onto the ordinary
request connection and left four behind, naming them honestly rather than fixing them:
``GET /admin/usage``, ``GET /admin/usage/series``, ``GET /admin/principals`` and
``GET /admin/principals/administrators`` kept ``AdministrativeSession``, which resolves
``DATABASE_URL_PRIVILEGED`` — a variable the request-serving container is deliberately never given
(``tests/test_secret_storage.py::test_the_render_service_never_holds_the_privileged_database_url``).
So all four returned 500 in production after authorization had already succeeded, which is what the
administrative screen drew as "Admin data could not be loaded", "The usage trend could not be
loaded" and a failed principals panel.

**Why ``0016`` could not simply include their tables.** ``llm_usage_events``, ``user_plans`` and
``profiles`` are user-owned, and ``admin_roles`` is owner-scoped on purpose. An administrator-gated
``SELECT`` policy on any of them would hand an administrator *other people's rows* —
``specs/authentication`` forbids it and
``test_saas_rls.py::test_a_new_user_owned_table_carries_an_owner_policy`` refuses it outright. That
refusal was correct and is not revisited here.

**What this does instead, and why it is the smaller change.** Row Level Security answers "which
rows may this session see", and the question these four endpoints ask is not about rows at all. So
the crossing happens inside four ``SECURITY DEFINER`` functions that return *only* what an
administrative screen is specified to show:

* ``weathra_admin_usage_aggregate`` and ``weathra_admin_usage_series`` — counts, sums, percentiles
  and the internal split. No ``user_id``, no ``request_id``, no ``agent_run_id``, no row. The
  grouping dimension is an allowlist inside the function body, so ``by=user_id`` is not a thing the
  function can be asked for however the caller spells it.
* ``weathra_admin_principals`` — the subject, the tier, when and by whom it was assigned, and
  whether the principal administers. That is the whole of ``PrincipalRecord``; Weathra stores no
  email, name or contact detail anywhere, so there is none here to withhold.
* ``weathra_admin_administrators`` — who holds the role and who granted it. It discloses nothing
  ``weathra_admin_principals`` does not already: that function carries the same flag per principal,
  because the plan-management screen shows it.

**Every one of them opens with the same gate.** ``weathra_is_administrative()`` — ``0011``'s
``SECURITY DEFINER`` predicate over ``admin_roles``, which reads backend state and which no claim,
header or body field can satisfy. A caller without the role gets ``insufficient_privilege`` from
PostgreSQL, not an empty result, so a handler that ever lost its ``AdministrativePrincipal``
dependency would fail loudly rather than quietly return the estate's totals. The authorization is
therefore asserted twice over the same state, as ``0016`` established: once by the dependency graph,
which produces the 401 and the 403, and once by the database.

**Nothing is widened.** No policy is created, dropped or altered by this revision; no table gains a
grant; ``llm_usage_events``, ``user_plans``, ``profiles`` and ``admin_roles`` keep exactly the owner
policies they have, so an ordinary session — an administrator's own included — still reads only its
own rows from all four, and every existing isolation test is untouched. ``EXECUTE`` is revoked from
``PUBLIC`` and granted to the restricted role alone, which is narrower than the default these
functions would otherwise carry.

**Why ``SECURITY DEFINER`` reaches across people at all.** The owner is the migration role, which
on Supabase is ``postgres`` — exempt from row level security, and not a superuser.
``weathra_is_administrative()`` itself has depended on exactly that since ``0011``, and
``test_db_migration_privileges.py`` applies the whole chain as a role shaped that way, so this is
the environment the functions are written for rather than an assumption about one.

Revision ID: 0018_admin_aggregates
Revises: 0017_admin_write_policies

The identifier is abbreviated for ``0016``'s reason: ``alembic_version.version_num`` is
``varchar(32)``, and the upgrade fails on the version bookkeeping *after* the DDL.
Create date: 2026-09-14
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0018_admin_aggregates"
down_revision: str | None = "0017_admin_write_policies"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Must match 0002's RESTRICTED_ROLE and Settings.database_restricted_role.
RESTRICTED_ROLE = "weathra_request"

# Must match `auth/roles.py`'s ADMINISTRATOR_ROLE.
ADMINISTRATOR_ROLE = "administrator"

# The refusal every function opens with. Written once because four copies of a security check is
# three chances to write it differently.
_GATE = """
    IF NOT public.weathra_is_administrative() THEN
        RAISE EXCEPTION 'the administrative role is required to read across principals'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
"""

# The dimensions `specs/llm-telemetry` requires aggregation by, and the whole of what the grouping
# argument may name. Must match `telemetry/aggregate.py`'s GROUPINGS, which
# `test_telemetry_persistence.py` asserts by asking the function for every key in it.
#
# A CASE rather than dynamic SQL, and the difference is the point: there is no spelling of the
# argument that reaches a column not on this list, so `by=user_id` cannot be answered rather than
# being refused by a check somebody could remove.
_GROUPING_CASE = """
        CASE p_group
            WHEN 'model'         THEN e.gateway_model
            WHEN 'catalog_key'   THEN e.catalog_key
            WHEN 'policy'        THEN e.policy_id
            WHEN 'plan'          THEN e.plan
            WHEN 'call_role'     THEN e.call_role
            WHEN 'status'        THEN e.status
            WHEN 'provider'      THEN e.gateway_provider
            WHEN 'failure_class' THEN e.failure_class
        END::text
"""

_USAGE_AGGREGATE = f"""
CREATE OR REPLACE FUNCTION weathra_admin_usage_aggregate(
    p_group text,
    p_start timestamptz,
    p_end   timestamptz
)
RETURNS TABLE (
    group_value            text,
    internal               boolean,
    calls                  bigint,
    failures               bigint,
    prompt_tokens_total    bigint,
    completion_tokens_total bigint,
    total_tokens_total     bigint,
    estimated_cost_total   numeric,
    latency_p50_ms         double precision,
    latency_p95_ms         double precision
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
{_GATE}
    IF p_group NOT IN ('model', 'catalog_key', 'policy', 'plan',
                       'call_role', 'status', 'provider', 'failure_class') THEN
        RAISE EXCEPTION '% is not an aggregation dimension', p_group
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    RETURN QUERY
    SELECT {_GROUPING_CASE},
           e.is_internal,
           count(*)::bigint,
           count(*) FILTER (WHERE e.status = 'failure')::bigint,
           sum(e.prompt_tokens)::bigint,
           sum(e.completion_tokens)::bigint,
           sum(e.total_tokens)::bigint,
           sum(e.estimated_cost)::numeric,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY e.latency_ms)::double precision,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY e.latency_ms)::double precision
      FROM public.llm_usage_events e
     WHERE (p_start IS NULL OR e.created_at >= p_start)
       AND (p_end IS NULL OR e.created_at < p_end)
     GROUP BY 1, e.is_internal
     ORDER BY e.is_internal, count(*) DESC, 1 NULLS LAST;
END;
$$
"""

_USAGE_SERIES = f"""
CREATE OR REPLACE FUNCTION weathra_admin_usage_series(
    p_bucket text,
    p_start  timestamptz,
    p_end    timestamptz
)
RETURNS TABLE (
    bucket_start         timestamptz,
    internal             boolean,
    calls                bigint,
    failures             bigint,
    total_tokens_total   bigint,
    estimated_cost_total numeric,
    latency_p50_ms       double precision
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
{_GATE}
    IF p_bucket NOT IN ('hour', 'day') THEN
        RAISE EXCEPTION '% is not a bucket width', p_bucket
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    RETURN QUERY
    SELECT date_trunc(p_bucket, e.created_at),
           e.is_internal,
           count(*)::bigint,
           count(*) FILTER (WHERE e.status = 'failure')::bigint,
           sum(e.total_tokens)::bigint,
           sum(e.estimated_cost)::numeric,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY e.latency_ms)::double precision
      FROM public.llm_usage_events e
     WHERE e.created_at >= p_start
       AND e.created_at <  p_end
     GROUP BY 1, e.is_internal;
END;
$$
"""

# Six columns, and they are `PrincipalRecord`'s six. A principal with no row in `user_plans`
# appears with a null plan rather than being left out: somebody who has never been assigned a tier
# is exactly who an administrator is looking for.
_PRINCIPALS = f"""
CREATE OR REPLACE FUNCTION weathra_admin_principals(p_limit integer)
RETURNS TABLE (
    subject_id     text,
    plan_code      text,
    plan_name      text,
    assigned_at    timestamptz,
    assigned_by    text,
    administrative boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
{_GATE}
    RETURN QUERY
    SELECT p.user_id::text,
           up.plan_code::text,
           sp.display_name::text,
           up.assigned_at,
           up.assigned_by::text,
           (ar.subject_id IS NOT NULL)
      FROM public.profiles p
      LEFT JOIN public.user_plans up ON up.user_id = p.user_id
      LEFT JOIN public.subscription_plans sp ON sp.plan_code = up.plan_code
      LEFT JOIN public.admin_roles ar
             ON ar.subject_id = p.user_id AND ar.role = '{ADMINISTRATOR_ROLE}'
     ORDER BY up.assigned_at DESC NULLS LAST, p.user_id
     LIMIT p_limit;
END;
$$
"""

_ADMINISTRATORS = f"""
CREATE OR REPLACE FUNCTION weathra_admin_administrators(p_role text)
RETURNS TABLE (
    subject_id text,
    role_name  text,
    granted_by text,
    granted_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
{_GATE}
    RETURN QUERY
    SELECT ar.subject_id::text,
           ar.role::text,
           ar.granted_by::text,
           ar.granted_at
      FROM public.admin_roles ar
     WHERE ar.role = p_role
     ORDER BY ar.granted_at, ar.subject_id;
END;
$$
"""

# Signature as PostgreSQL identifies it, for the grants and for the drops.
SIGNATURES = (
    "weathra_admin_usage_aggregate(text, timestamptz, timestamptz)",
    "weathra_admin_usage_series(text, timestamptz, timestamptz)",
    "weathra_admin_principals(integer)",
    "weathra_admin_administrators(text)",
)

COMMENTS = {
    "weathra_admin_usage_aggregate(text, timestamptz, timestamptz)": (
        "Aggregate language model usage over a period, grouped by one allowlisted dimension and "
        "split internal from product. Measures only — never a row and never a subject. Refuses a "
        "caller who does not hold the administrative role in admin_roles."
    ),
    "weathra_admin_usage_series(text, timestamptz, timestamptz)": (
        "The same measures cut by time rather than by dimension, bucketed by hour or day. Sparse: "
        "the caller fills the empty buckets, because only it knows the window it asked for."
    ),
    "weathra_admin_principals(integer)": (
        "Every principal with their tier and whether they administer. A subject and a tier — "
        "Weathra stores no contact detail to return."
    ),
    "weathra_admin_administrators(text)": (
        "Who holds one role and who granted it to them. Discloses nothing weathra_admin_principals "
        "does not, which carries the same flag per principal."
    ),
}


def upgrade() -> None:
    for statement in (_USAGE_AGGREGATE, _USAGE_SERIES, _PRINCIPALS, _ADMINISTRATORS):
        op.execute(statement)

    for signature in SIGNATURES:
        # Narrower than the default. `EXECUTE` on a new function is granted to PUBLIC, and these
        # four cross between people — so the grant is stated rather than inherited, and the
        # restricted role is the only one that holds it.
        op.execute(f"REVOKE ALL ON FUNCTION {signature} FROM PUBLIC")
        op.execute(f"GRANT EXECUTE ON FUNCTION {signature} TO {RESTRICTED_ROLE}")
        op.execute(f"COMMENT ON FUNCTION {signature} IS '{COMMENTS[signature]}'")


def downgrade() -> None:
    for signature in SIGNATURES:
        op.execute(f"DROP FUNCTION IF EXISTS {signature}")
