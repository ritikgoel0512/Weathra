"""administrator-gated read access on the request connection

Task 34.5. Every administrative endpoint returned 500 in production, and the cause was not in any
of them: ``administrative_db`` opened the **privileged** connection, and the request-serving
container is deliberately never given that credential —
``tests/test_secret_storage.py::test_the_render_service_never_holds_the_privileged_database_url``
asserts exactly that, and says why: migrations run from GitHub Actions precisely so the
browser-facing container never holds a connection that bypasses Row Level Security. So the
administrative API could not work in production as written, and the ``db`` suite never noticed
because it runs where both credentials exist.

This revision resolves it the way that keeps the invariant: the administrative **reads** move to
the ordinary request connection, and the rows they need become reachable there *only* to a
principal the database itself confirms holds the role.

**The gate is ``weathra_is_administrative()``, which ``0011`` already built.** It reads
``admin_roles`` for the acting session's subject, it is ``SECURITY DEFINER`` so the policy can ask
a question the caller cannot answer for themselves, and it is backend state rather than a token
claim — ``0011`` replaced the claim-reading accessor with this one for that reason. A caller who
asserts ``weathra_role`` in a header, a body or a token gets exactly nothing from it. No second
administrator model is introduced here, and none is needed.

``0007``'s four tables had no grant and RLS with no policy — "nothing, stated twice". They now
carry a grant and one policy, and that policy is the whole of what the restricted role can do with
them: ``SELECT``, and only while the session's own subject holds the role. The reasoning in ``0007``
was that "nothing on the request path has any business reading a comparison run's provenance or the
audit trail of who changed which model". That stands for an ordinary request path. It does not
describe an administrator reading the evidence surface ``specs/web-ui`` requires of task 34.8,
which is a request path too — and the alternative to this policy was handing the whole container a
credential that bypasses every policy on every table.

Every other table keeps exactly the access it had. The tables an administrative screen reads
*across people* — ``llm_usage_events``, ``user_plans`` — and ``admin_roles``, which would let one
administrator enumerate the others, are deliberately not here; see the note above the table lists.

**What this deliberately does not do.** No write is granted to the restricted role anywhere. Every
administrative mutation — the catalog edit, the policy candidate order, the plan mapping, the role
grant, and the ``admin_audit`` row each of them writes — stays on the privileged connection, which
means it stays out of the request-serving container. ``0005``'s rule that the request path writes
none of the operational tables is untouched, and ``admin_roles`` in particular gains no write here:
a self-service administrative grant remains impossible, which is the one thing that table exists to
make impossible.

**No existing policy is changed, dropped or widened.** Only the four tables that had none gain
one. Every ownership rule in the schema stands exactly as it did, including ``0011``'s observation
that its owner-read policy keeps the administrative predicate from being turned into a way of
enumerating who else is an administrator.

Revision ID: 0016_admin_read_policies
Revises: 0015_user_plan_self_selection

The identifier is abbreviated because ``alembic_version.version_num`` is ``varchar(32)`` and
``0016_administrative_read_policies`` is thirty-three characters — the upgrade fails on the version
bookkeeping *after* the DDL, which transactional DDL then rolls back in full.
Create date: 2026-09-14
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0016_admin_read_policies"
down_revision: str | None = "0015_user_plan_self_selection"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

RESTRICTED_ROLE = "weathra_request"

# `0007`'s tables: no grant and no policy today, so both are added.
LAB_AND_AUDIT_TABLES = (
    "model_evaluations",
    "model_comparison_runs",
    "model_comparison_results",
    "admin_audit",
)

# `admin_roles` was in this migration for one revision and was taken out, along with
# `llm_usage_events` and `user_plans`. All three already grant the restricted role `SELECT` under an
# owner policy, and adding an administrator-gated policy beside it would have widened what an
# administrator can see beyond what task 34.5 needs:
#
# * `llm_usage_events` and `user_plans` are user-owned, so it would have granted an administrator
#   another person's rows — `specs/authentication` forbids it and
#   `test_saas_rls.py::test_a_new_user_owned_table_carries_an_owner_policy` refuses it outright.
# * `admin_roles` would have let an administrator enumerate the other administrators.
#   `test_admin_roles.py::test_a_caller_reads_their_own_role_row_and_no_other` states the reason
#   plainly: without the owner policy standing alone, "am I an administrator" is a query that can
#   be rewritten into "who else is". 34.5's evidence surface does not need that answer, so it is
#   not granted.
#
# `GET /admin/usage`, `/admin/usage/series`, `/admin/principals` and
# `/admin/principals/administrators` therefore keep the privileged connection and keep failing in
# the request-serving container. That is an honest blocker rather than a policy that quietly widens
# what an administrator can see.

ALL_TABLES = LAB_AND_AUDIT_TABLES


def upgrade() -> None:
    # The gate itself. `EXECUTE` is granted to PUBLIC by default, so this is a statement of intent
    # rather than a change — and it means a later revision that revokes PUBLIC does not silently
    # take the administrative surface down with it.
    op.execute(f"GRANT EXECUTE ON FUNCTION weathra_is_administrative() TO {RESTRICTED_ROLE}")

    for table in LAB_AND_AUDIT_TABLES:
        op.execute(f"GRANT SELECT ON {table} TO {RESTRICTED_ROLE}")

    for table in ALL_TABLES:
        op.execute(
            f"""
            CREATE POLICY {table}_admin_read ON {table}
            FOR SELECT
            TO {RESTRICTED_ROLE}
            USING (weathra_is_administrative())
            """
        )


def downgrade() -> None:
    for table in ALL_TABLES:
        op.execute(f"DROP POLICY IF EXISTS {table}_admin_read ON {table}")

    # Back to "nothing, stated twice" for `0007`'s four. The other three keep the grant they had
    # before this revision, which is why only these are revoked.
    for table in LAB_AND_AUDIT_TABLES:
        op.execute(f"REVOKE ALL ON {table} FROM {RESTRICTED_ROLE}")

    op.execute(f"REVOKE EXECUTE ON FUNCTION weathra_is_administrative() FROM {RESTRICTED_ROLE}")
