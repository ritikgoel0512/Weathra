"""the one grant account deletion needs, and the one it deliberately does not take

``specs/llm-telemetry`` requires a person's raw usage events to be removed when their account data
is deleted, and their consumption counters are their data by the same argument. Deletion runs on
the request path — a caller deleting their own account — under ``weathra_request``, so it can only
remove what that role is granted and what Row Level Security admits. The two tables need different
answers.

**``llm_usage_events`` needs nothing, and must keep needing nothing.** ``0006`` declares
``user_id`` as ``ON DELETE CASCADE`` from ``profiles``: removing the profile removes the events,
and a referential action is performed by the system rather than by the caller, so it is not
gated on the caller holding ``DELETE``. That is what lets the table stay append-only for the
request role — ``SELECT`` and ``INSERT``, no more. Granting ``DELETE`` to make the deletion
explicit would have bought a tidier statement at the price of letting the request path erase one
usage event at a time, which is exactly the property that makes the table worth reading.

**``usage_counters`` needs the grant, because nothing cascades it.** ``subject`` is text and not a
foreign key on purpose (``0006``): internal traffic counts against a reserved non-UUID subject that
must never acquire a profile. So no cascade reaches these rows and the deletion has to issue the
statement itself. The grant is confined by the ``usage_counters_owner_only`` policy already in
force, which is ``FOR ALL`` and therefore covers ``DELETE``: a caller may remove rows whose
``subject`` is their own id and no others, and the reserved internal subject is denied to everyone
by arithmetic, since no UUID equals ``internal``.

This is not new power in any meaningful sense. ``0006`` already grants ``UPDATE`` on this table
because the request path upserts its own consumption, so a caller who could reach past the
application could already set a counter to zero; ``DELETE`` reaches the same end by a different
verb. It is new power over ``llm_usage_events``, which is why that half stays as it is.

No policy is created, altered or dropped here.

Revision ID: 0009_usage_counter_delete_grant
Revises: 0008_seed_model_policy_data
Create date: 2026-09-09
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0009_usage_counter_delete_grant"
down_revision: str | None = "0008_seed_model_policy_data"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Must match 0002's RESTRICTED_ROLE and Settings.database_restricted_role.
RESTRICTED_ROLE = "weathra_request"


def upgrade() -> None:
    op.execute(f"GRANT DELETE ON usage_counters TO {RESTRICTED_ROLE}")


def downgrade() -> None:
    op.execute(f"REVOKE DELETE ON usage_counters FROM {RESTRICTED_ROLE}")
