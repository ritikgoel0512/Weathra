"""the claims accessor for the administrative role, and the internal counter it unlocks

``specs/usage-limits`` requires administrative traffic to be accounted against the *internal*
allowance rather than against the plan of the account the administrator happens to be signed in
as. On the request path that means a session bound to one person's claims has to increment the row
at ``subject = 'internal'`` — and ``0006``'s ``usage_counters_owner_only`` policy denies it,
correctly, because ``'internal'`` is not anybody's user id.

Widening that policy is not the answer. A rule that let any caller write the internal subject would
let anyone drain the internal allowance, and — worse — let anyone book their own consumption to a
counter nobody's plan reads. So this adds a *second* policy, permissive alongside the first, that
admits exactly one subject to exactly the callers whose validated token says they hold the
administrative role.

**The accessor mirrors `entitlements/administration.py`, deliberately and exactly.** Same claim
name, same containers, same case-insensitive comparison, same refusal to look in ``user_metadata``
— which Supabase lets the account holder write, so a role read from it would be self-service
administration. Two implementations of "is this an administrator" is one more than is safe, and
this one exists only because a Row Level Security policy cannot call Python. A test asserts the two
agree over the same claim shapes.

``weathra_is_administrative()`` returns false for an unbound session, for a session with no role
claim, and for a claim naming any other role — the three ways of not being an administrator, all
of which must read as denial rather than as an error inside a policy.

Revision ID: 0010_internal_quota_accounting
Revises: 0009_usage_counter_delete_grant
Create date: 2026-09-09
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0010_internal_quota_accounting"
down_revision: str | None = "0009_usage_counter_delete_grant"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Must match 0002's RESTRICTED_ROLE and Settings.database_restricted_role.
RESTRICTED_ROLE = "weathra_request"

# Must match `entitlements/administration.py`: ROLE_CLAIM, ADMINISTRATOR_ROLE, _CLAIM_CONTAINERS.
ROLE_CLAIM = "weathra_role"
ADMINISTRATOR_ROLE = "administrator"
CLAIM_CONTAINER = "app_metadata"

# Must match `domain/usage.py`'s INTERNAL_SUBJECT.
INTERNAL_SUBJECT = "internal"

_ACCESSOR = f"""
CREATE OR REPLACE FUNCTION weathra_is_administrative() RETURNS boolean
LANGUAGE sql STABLE
AS $$
    WITH claims AS (
        -- Unset on a fresh connection, empty where a session binds no principal. Both must read
        -- as "not an administrator", so they are coalesced before the cast, which would raise
        -- on an empty string.
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
        -- A claim may be one role or a list of them, and neither shape may be assumed.
        SELECT jsonb_array_elements_text(value) AS role_name
          FROM declared WHERE jsonb_typeof(value) = 'array'
        UNION ALL
        SELECT value #>> '{{}}' FROM declared WHERE jsonb_typeof(value) = 'string'
    )
    SELECT coalesce(bool_or(btrim(lower(role_name)) = '{ADMINISTRATOR_ROLE}'), false) FROM roles
$$
"""


def upgrade() -> None:
    op.execute(_ACCESSOR)
    op.execute(
        "COMMENT ON FUNCTION weathra_is_administrative() IS "
        "'Whether the acting session''s validated claims declare Weathra''s administrative role. "
        "Mirrors entitlements/administration.py; false for an unbound session.'"
    )
    # Permissive, so it is OR'd with `usage_counters_owner_only` rather than replacing it. Nothing
    # about the owner policy changes: a product caller reaches exactly the rows they reached before.
    op.execute(
        f"""
        CREATE POLICY usage_counters_internal_administrative ON usage_counters
        FOR ALL
        TO {RESTRICTED_ROLE}
        USING (subject = '{INTERNAL_SUBJECT}' AND weathra_is_administrative())
        WITH CHECK (subject = '{INTERNAL_SUBJECT}' AND weathra_is_administrative())
        """
    )


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS usage_counters_internal_administrative ON usage_counters")
    op.execute("DROP FUNCTION IF EXISTS weathra_is_administrative()")
