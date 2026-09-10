"""Weather watches: a condition somebody asked Weathra to check at a place.

Additive and nothing else. One new table, owned by the user who created it, under the same
row-level security every other user-owned table has carried since ``0002``: enabled, **forced**, and
an owner-only policy for all four verbs. Forced because migrations and requests share a database
user on managed Postgres, and an unforced policy does not bind the table's owner — which would make
the isolation a decoration.

**No scheduler is created here, and none is implied.** Weathra has nothing that runs on a timer, so
a watch is evaluated when somebody looks at it or asks for it to be refreshed. That is why the table
carries ``last_evaluated_at`` beside ``last_value`` and ``last_met``: the row records an evaluation
that happened at a stated moment, not a condition being continuously monitored. A column named
``triggered`` with no clock behind it would be a claim the system cannot keep.

``last_met`` is nullable on purpose and its null is not "no". Before the first evaluation there is
no answer, and where the provider reported nothing for the measure there is still no answer —
neither is the same as the condition being unmet, and collapsing the three into a boolean would make
a silent provider look like calm weather.

Revision ID: 0012_weather_watches
Revises: 0011_administrative_role_state
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0012_weather_watches"
down_revision: str | None = "0011_administrative_role_state"
branch_labels: str | None = None
depends_on: str | None = None

# The role a request-scoped session *assumes*, which is the one the policies constrain and the one
# that therefore needs the grant. Must match ``Settings.database_restricted_role`` and the name
# `0002` granted the other user-owned tables to. It is emphatically **not** ``weathra_api``, which
# is the LOGIN role `0003` created and which must hold no table privilege at all: the role switch
# is what grants access, and a grant to the login role would let a request skip it.
RESTRICTED_ROLE = "weathra_request"

TABLE = "weather_watches"


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("id", UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "user_id",
            UUID(as_uuid=False),
            sa.ForeignKey("profiles.user_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("location_id", sa.String(64), nullable=False),
        sa.Column("location", JSONB, nullable=False),
        sa.Column("label", sa.String(200), nullable=True),
        sa.Column("measure", sa.String(64), nullable=False),
        sa.Column("comparison", sa.String(8), nullable=False),
        sa.Column("threshold", sa.Float, nullable=False),
        sa.Column("enabled", sa.Boolean, nullable=False, server_default=sa.text("true")),
        sa.Column("last_evaluated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_value", sa.Float, nullable=True),
        sa.Column("last_met", sa.Boolean, nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        # The direction is one of two words. A check rather than an enum type, because adding a
        # value to a Postgres enum is a migration and adding one here is a line.
        sa.CheckConstraint(
            "comparison IN ('above', 'below')", name="ck_weather_watches_comparison"
        ),
        sa.UniqueConstraint(
            "user_id", "location_id", "measure", name="uq_weather_watches_user_place_measure"
        ),
    )
    op.create_index("ix_weather_watches_user", TABLE, ["user_id"])

    # The same grant and the same policy as every other user-owned table, so there is one rule in
    # this system rather than one rule and an exception.
    op.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON {TABLE} TO {RESTRICTED_ROLE}")
    op.execute(f"ALTER TABLE {TABLE} ENABLE ROW LEVEL SECURITY")
    op.execute(f"ALTER TABLE {TABLE} FORCE ROW LEVEL SECURITY")
    op.execute(
        f"""
        CREATE POLICY {TABLE}_owner_only ON {TABLE}
        FOR ALL
        USING (user_id::text = weathra_current_user_id())
        WITH CHECK (user_id::text = weathra_current_user_id())
        """
    )


def downgrade() -> None:
    op.execute(f"DROP POLICY IF EXISTS {TABLE}_owner_only ON {TABLE}")
    op.execute(f"ALTER TABLE {TABLE} NO FORCE ROW LEVEL SECURITY")
    op.execute(f"ALTER TABLE {TABLE} DISABLE ROW LEVEL SECURITY")
    op.execute(f"REVOKE ALL ON {TABLE} FROM {RESTRICTED_ROLE}")
    op.drop_index("ix_weather_watches_user", table_name=TABLE)
    op.drop_table(TABLE)
