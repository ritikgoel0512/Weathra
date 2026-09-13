"""Weather Watch becomes a monitored thing rather than a form that answers when you open it.

`0012` gave a watch a threshold and three columns recording the last time somebody looked. That is
all a screen-triggered check needs, and it is not enough for monitoring: a watch that is evaluated
on a schedule has a *history*, and a history is what makes "the condition changed at 14:00" a
statement anybody can check rather than a claim the interface makes about itself.

So this adds the two tables a scheduled evaluator needs and the columns a watch needs to carry its
own state between passes.

``weather_watch_evaluations`` — one row per check, of any outcome. A failed retrieval is a row too,
carrying ``degraded`` and the reason, because "we could not look" and "we looked and it was calm"
are different facts about a monitoring product and only one of them is about the weather. The row
carries the provider and the retrieval timestamp so the evidence a screen shows can be traced to a
specific retrieval rather than to whatever the provider happens to say now.

``weather_watch_events`` — one row per *transition*, which is the far smaller set a person actually
reads. Deriving these at read time from the evaluations would be possible and wrong: the evaluator
knows what the previous state was at the moment it wrote the new one, and recomputing that later
from a table subject to retention would silently change the history as old rows expired.

On ``weather_watches`` itself: ``state`` and ``previous_state`` hold what the last pass concluded,
``unit`` records the unit the reading was expressed in, ``last_error`` records why a degraded pass
degraded, and ``next_evaluation_at`` is the moment the schedule is next expected to reach this
watch. Every one of them is nullable, so every existing row remains valid as it stands and the
first pass fills them in.

**Still no in-process scheduler, and design decision 11 is why.** The evaluator runs from a
scheduled CI job under the privileged connection, exactly as retention does, because evaluating
watches belonging to *other people* is precisely the work the request-serving role must not be able
to do. Nothing in this revision grants the request path anything it did not already have.

Revision ID: 0014_weather_watch_monitoring
Revises: 0013_weather_watch_grant_repair
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0014_weather_watch_monitoring"
down_revision: str | None = "0013_weather_watch_grant_repair"
branch_labels: str | None = None
depends_on: str | None = None

# The role a request-scoped session assumes — the one the policies constrain, and therefore the one
# that needs the grant. Emphatically not the LOGIN role, which must hold no table privilege at all:
# the role switch is what grants access, and `0013` exists because that was got wrong once.
RESTRICTED_ROLE = "weathra_request"

WATCHES = "weather_watches"
EVALUATIONS = "weather_watch_evaluations"
EVENTS = "weather_watch_events"

# The states an evaluation may conclude in. A check constraint rather than a Postgres enum, for the
# same reason `0012` made the direction one: adding a value to an enum is a migration and adding one
# here is a line.
STATES = "('met', 'not_met', 'no_reading', 'degraded', 'paused', 'pending')"


def _secure(table: str) -> None:
    """The grant and the policy every user-owned table in this system carries.

    Forced, because migrations and requests share a database user on managed Postgres and an
    unforced policy does not bind the table's owner — which would make the isolation a decoration.
    """
    op.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO {RESTRICTED_ROLE}")
    op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
    op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
    op.execute(
        f"""
        CREATE POLICY {table}_owner_only ON {table}
        FOR ALL
        USING (user_id::text = weathra_current_user_id())
        WITH CHECK (user_id::text = weathra_current_user_id())
        """
    )


def _unsecure(table: str) -> None:
    op.execute(f"DROP POLICY IF EXISTS {table}_owner_only ON {table}")
    op.execute(f"ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY")
    op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")
    op.execute(f"REVOKE ALL ON {table} FROM {RESTRICTED_ROLE}")


def upgrade() -> None:
    # ------------------------------------------------------------------ the watch's own state
    op.add_column(WATCHES, sa.Column("state", sa.String(16), nullable=True))
    op.add_column(WATCHES, sa.Column("previous_state", sa.String(16), nullable=True))
    op.add_column(WATCHES, sa.Column("last_unit", sa.String(16), nullable=True))
    op.add_column(WATCHES, sa.Column("last_error", sa.String(200), nullable=True))
    op.add_column(
        WATCHES, sa.Column("next_evaluation_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.create_check_constraint(
        "ck_weather_watches_state", WATCHES, f"state IS NULL OR state IN {STATES}"
    )
    # The scheduled pass reads every enabled watch across every user, in one statement, ordered by
    # place so it can group retrievals. Without this it is a sequential scan per pass.
    op.create_index(
        "ix_weather_watches_due",
        WATCHES,
        ["enabled", "location_id"],
        postgresql_where=sa.text("enabled"),
    )

    # ------------------------------------------------------------------ one row per check
    op.create_table(
        EVALUATIONS,
        sa.Column("id", UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "watch_id",
            UUID(as_uuid=False),
            sa.ForeignKey(f"{WATCHES}.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # Denormalised from the watch so the policy on this table needs no join. A policy that has
        # to reach another table to decide is a policy that can be defeated by that table's own.
        sa.Column(
            "user_id",
            UUID(as_uuid=False),
            sa.ForeignKey("profiles.user_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("evaluated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("value", sa.Float, nullable=True),
        sa.Column("unit", sa.String(16), nullable=True),
        sa.Column("threshold", sa.Float, nullable=False),
        sa.Column("comparison", sa.String(8), nullable=False),
        sa.Column("condition_met", sa.Boolean, nullable=True),
        sa.Column("provider", sa.String(64), nullable=True),
        sa.Column("retrieved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("matched_at", sa.DateTime(timezone=True), nullable=True),
        # The outcome's own arithmetic — margin, peak, first crossing, points used — as the
        # evaluator computed it, so a screen reads the figures that produced the state rather than
        # recomputing them from a series it would have to retrieve again.
        sa.Column("evidence", JSONB, nullable=True),
        sa.Column("error", sa.String(200), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(f"state IN {STATES}", name=f"ck_{EVALUATIONS}_state"),
    )
    op.create_index(
        f"ix_{EVALUATIONS}_watch", EVALUATIONS, ["watch_id", sa.text("evaluated_at DESC")]
    )
    op.create_index(f"ix_{EVALUATIONS}_user", EVALUATIONS, ["user_id"])
    _secure(EVALUATIONS)

    # ------------------------------------------------------------------ one row per transition
    op.create_table(
        EVENTS,
        sa.Column("id", UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "watch_id",
            UUID(as_uuid=False),
            sa.ForeignKey(f"{WATCHES}.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            UUID(as_uuid=False),
            sa.ForeignKey("profiles.user_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("event_type", sa.String(32), nullable=False),
        sa.Column("previous_state", sa.String(16), nullable=True),
        sa.Column("new_state", sa.String(16), nullable=True),
        sa.Column("summary", sa.String(400), nullable=False),
        sa.Column("delta", sa.Float, nullable=True),
        sa.Column("unit", sa.String(16), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index(f"ix_{EVENTS}_watch", EVENTS, ["watch_id", sa.text("occurred_at DESC")])
    op.create_index(f"ix_{EVENTS}_user", EVENTS, ["user_id", sa.text("occurred_at DESC")])
    _secure(EVENTS)


def downgrade() -> None:
    _unsecure(EVENTS)
    op.drop_index(f"ix_{EVENTS}_user", table_name=EVENTS)
    op.drop_index(f"ix_{EVENTS}_watch", table_name=EVENTS)
    op.drop_table(EVENTS)

    _unsecure(EVALUATIONS)
    op.drop_index(f"ix_{EVALUATIONS}_user", table_name=EVALUATIONS)
    op.drop_index(f"ix_{EVALUATIONS}_watch", table_name=EVALUATIONS)
    op.drop_table(EVALUATIONS)

    op.drop_index("ix_weather_watches_due", table_name=WATCHES)
    op.drop_constraint("ck_weather_watches_state", WATCHES, type_="check")
    for column in ("next_evaluation_at", "last_error", "last_unit", "previous_state", "state"):
        op.drop_column(WATCHES, column)
