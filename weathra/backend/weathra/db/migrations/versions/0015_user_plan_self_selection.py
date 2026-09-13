"""Let a person move themselves between tiers, and let the database be what enforces "themselves".

`0006` granted the request-serving role ``SELECT`` on ``user_plans`` and nothing else, with a
comment naming the reason: it is *"the one table where a permissive write is a self-service
upgrade"*. That was correct for the product as it stood — tiers were an administrative assignment,
and ``specs/usage-limits`` said so in a scenario that refused an ordinary caller changing their own
plan.

**The product decision changed on 2026-09-13**: Free, Pro and Premium are now self-selectable by
the account they apply to. Nothing is charged, because nothing bills — `specs/usage-limits`'s
refusal of payment processing is untouched and a tier still costs nobody anything. What changes is
who may write the row.

**Why a grant and a policy rather than a privileged write in application code.** The alternative
was to keep this table read-only to the request role and have the endpoint write through the
privileged connection, the way an administrative assignment does. That would have been *weaker*:
a privileged write bypasses Row Level Security entirely, so "only your own row" would have been a
property of one Python function, upheld by review. Here the database refuses a foreign write no
matter what the endpoint asks — ``WITH CHECK`` on both verbs, against the same
``weathra_current_user_id()`` accessor every other owner policy tests. Cross-account mutation is
not a bug that can be written.

**DELETE is still not granted, and that is not an oversight.** Removing a row would put somebody
back on Free through absence rather than through a choice, and would lose ``assigned_by`` and
``assigned_at``. Choosing Free is an ``UPDATE`` to ``plan_code = 'free'``, which leaves the record
of who chose it and when. The administrative path (`PlanStore.assign`) is unchanged and still runs
under the privileged connection.

Revision ID: 0015_user_plan_self_selection
Revises: 0014_weather_watch_monitoring
Create date: 2026-09-13
"""

from __future__ import annotations

from alembic import op

revision: str = "0015_user_plan_self_selection"
down_revision: str | None = "0014_weather_watch_monitoring"
branch_labels: str | None = None
depends_on: str | None = None

TABLE = "user_plans"
# Must match 0002's RESTRICTED_ROLE and Settings.database_restricted_role.
RESTRICTED_ROLE = "weathra_request"
# The accessor 0002 created, which every owner policy in this database tests.
CURRENT_USER = "weathra_current_user_id()"


def upgrade() -> None:
    # INSERT and UPDATE only. `0006`'s `user_plans_owner_read` still carries SELECT, and DELETE is
    # withheld for the reason in this module's docstring.
    op.execute(f"GRANT INSERT, UPDATE ON {TABLE} TO {RESTRICTED_ROLE}")

    # Two policies rather than one FOR ALL: replacing the read policy would mean restating it, and
    # a restated policy is one that can be restated wrong.
    op.execute(
        f"""
        CREATE POLICY user_plans_owner_insert ON {TABLE}
        FOR INSERT
        TO {RESTRICTED_ROLE}
        WITH CHECK (user_id::text = {CURRENT_USER})
        """
    )
    # USING decides which rows may be updated; WITH CHECK decides what they may become. Both are
    # needed: USING alone would let an owner rewrite their row's `user_id` to somebody else's.
    op.execute(
        f"""
        CREATE POLICY user_plans_owner_update ON {TABLE}
        FOR UPDATE
        TO {RESTRICTED_ROLE}
        USING (user_id::text = {CURRENT_USER})
        WITH CHECK (user_id::text = {CURRENT_USER})
        """
    )


def downgrade() -> None:
    op.execute(f"DROP POLICY IF EXISTS user_plans_owner_update ON {TABLE}")
    op.execute(f"DROP POLICY IF EXISTS user_plans_owner_insert ON {TABLE}")
    op.execute(f"REVOKE INSERT, UPDATE ON {TABLE} FROM {RESTRICTED_ROLE}")
