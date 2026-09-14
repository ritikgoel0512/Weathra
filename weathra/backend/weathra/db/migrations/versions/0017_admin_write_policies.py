"""administrator-gated candidate-order confirmation on the request connection

Task 34.5's last blocker. `0016` moved the administrative *reads* onto the ordinary request
connection, because the request-serving container is deliberately never given the privileged
credential — ``test_secret_storage.py`` asserts it in
``test_the_render_service_never_holds_the_privileged_database_url``, and explains that migrations
run from GitHub Actions precisely so the browser-facing
container never holds a connection that bypasses Row Level Security. The writes were left behind,
and one of them is a product requirement rather than an operator convenience.

``PUT /api/v1/admin/policies/{policy_id}/candidates`` is the audited write task 34.8 specifies: an
administrator confirms a policy's candidate order, citing the comparison run relied upon, and the
result is read back from the audit trail rather than assumed. In production it failed with an
internal error before the handler ran at all — ``AdministrativeSession`` raised
``DATABASE_URL_PRIVILEGED is not configured`` while resolving, which is why no audit row was
written and why the refusal carried no 403. This revision is what lets that one write happen where
it has to happen.

**Two grants, and they are the two statements the confirmation makes.** ``set_candidates`` issues
``UPDATE model_policies SET candidate_catalog_keys = …`` and then ``record_change`` inserts the
``admin_audit`` row that records it, in one transaction. So: ``UPDATE`` on the first, ``INSERT`` on
the second, each behind a policy gated on ``weathra_is_administrative()`` — the ``SECURITY DEFINER``
predicate over ``admin_roles`` that ``0011`` built, which reads backend state and which no claim,
header or body field can satisfy.

**What is deliberately not granted.** No ``DELETE`` anywhere: an audit trail that can be pruned by
the role it audits is not an audit trail, and a policy row is re-pointed rather than removed.
No ``INSERT`` or ``UPDATE`` on ``model_catalog``, ``subscription_plans``, ``usage_limits``,
``admin_roles``, or any user-owned table — every other administrative mutation keeps the privileged
connection, which is to say it keeps running somewhere other than this container. ``admin_roles`` in
particular gains nothing here, so a self-service administrative grant remains impossible, which is
the one thing that table exists to make impossible.

**The ``WITH CHECK`` is not decoration.** On the ``UPDATE`` it means a row cannot be written into a
state the same predicate would not have allowed it to be read in, and on the ``INSERT`` it is the
whole control: it is what stops a caller who is not an administrator from appending to the trail.
``0005``'s rule that the request path writes none of the operational tables was written when there
was no administrative surface on the request path; it now has exactly one, and only for a principal
the database itself confirms.

Revision ID: 0017_admin_write_policies
Revises: 0016_admin_read_policies
Create date: 2026-09-14
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0017_admin_write_policies"
down_revision: str | None = "0016_admin_read_policies"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

RESTRICTED_ROLE = "weathra_request"


def upgrade() -> None:
    # The candidate order itself. `UPDATE` only: the row exists and is re-pointed, never created or
    # removed from here.
    op.execute(f"GRANT UPDATE ON model_policies TO {RESTRICTED_ROLE}")
    op.execute(
        f"""
        CREATE POLICY model_policies_admin_write ON model_policies
        FOR UPDATE
        TO {RESTRICTED_ROLE}
        USING (weathra_is_administrative())
        WITH CHECK (weathra_is_administrative())
        """
    )

    # The record of it. `INSERT` only, so the trail is append-only to this role by grant rather
    # than by convention.
    op.execute(f"GRANT INSERT ON admin_audit TO {RESTRICTED_ROLE}")
    op.execute(
        f"""
        CREATE POLICY admin_audit_admin_append ON admin_audit
        FOR INSERT
        TO {RESTRICTED_ROLE}
        WITH CHECK (weathra_is_administrative())
        """
    )


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS admin_audit_admin_append ON admin_audit")
    op.execute(f"REVOKE INSERT ON admin_audit FROM {RESTRICTED_ROLE}")
    op.execute("DROP POLICY IF EXISTS model_policies_admin_write ON model_policies")
    op.execute(f"REVOKE UPDATE ON model_policies FROM {RESTRICTED_ROLE}")
