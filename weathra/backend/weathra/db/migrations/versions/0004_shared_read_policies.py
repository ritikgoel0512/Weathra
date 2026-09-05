"""policies for the shared tables the request path reads

``0002`` gave ``weathra_request`` grants on three tables nobody owns — ``forecast_snapshots``,
``knowledge_documents`` and ``knowledge_chunks`` — and wrote no policies for them, because it also
did not enable Row Level Security on them. Grant-only access was the intended design: these rows
belong to the project rather than to a person, so there is no ownership predicate to write.

That held on a stock PostgreSQL and stopped holding on Supabase, which runs an ``ensure_rls`` event
trigger that enables Row Level Security on every table created in ``public``. The three tables came
out of ``0001`` with RLS on and no policy, and **a grant does not survive that**: RLS enabled with
no applicable policy denies every row to any role that is neither the table owner nor ``BYPASSRLS``.
``weathra_request`` is neither. So the corpus search returned nothing and the snapshot append was
rejected, with an ACL that looked entirely correct in every catalog view — the quiet kind of
failure, discovered as an empty result set rather than as an error.

The fix is not to disable RLS. Leaving it on and stating the access explicitly is worth more than
the pre-existing grant-only arrangement, because these tables are reachable by Supabase's own
``anon`` and ``authenticated`` roles through PostgREST; with RLS on and every policy scoped to
``weathra_request``, those roles are denied rather than merely ungranted. So this migration enables
RLS on all three deliberately — on a stock PostgreSQL as well, so a test cluster and a real project
agree instead of differing in the one property being tested — and adds one policy per operation the
request path actually performs.

**The policies mirror 0002's grants exactly**, which is the whole discipline here:

    forecast_snapshots     SELECT, INSERT     read a prior forecast, append the current one
    knowledge_documents    SELECT             the corpus join in retrieval
    knowledge_chunks       SELECT             vector search

``UPDATE`` and ``DELETE`` on ``forecast_snapshots`` get no policy, because the request path never
performs them: retention deletes expired snapshots under the privileged connection. The absent
policy and the absent grant say the same thing twice, which is the point.

**Why the predicate is ``true``.** There is no ownership to check. ``forecast_snapshots`` carries no
user column on purpose (see ``db/models.py``) — keying by location rather than requester avoids
storing a browsing trail — and the corpus is the same corpus for everyone. A policy is the wrong
instrument for bounding this data and time is the right one, which is what retention does. What the
policy *does* carry is the role scope: the access is granted to ``weathra_request`` and to nothing
else, so the shared data stays reachable only through the request path's ``SET LOCAL ROLE``.

**Not ``FORCE``, unlike 0002's user-owned tables.** Forcing would apply these policies to the table
owner too, and the owner is the privileged connection that ingests the corpus and runs retention —
both of which legitimately touch every row and neither of which is ``weathra_request``.

Revision ID: 0004_shared_read_policies
Revises: 0003_request_login_role
Create date: 2026-09-05
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0004_shared_read_policies"
down_revision: str | None = "0003_request_login_role"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Must match 0002's RESTRICTED_ROLE and Settings.database_restricted_role.
RESTRICTED_ROLE = "weathra_request"

# Shared tables the request path only reads. 0002 grants SELECT and nothing else; writing the
# corpus is the privileged ingestion routine's job (`rag/store.py::ingest_corpus`).
READ_ONLY_TABLES = ("knowledge_documents", "knowledge_chunks")

# Shared and appended to: the request path reads the previous snapshot and writes the current one
# (`weather/snapshots.py`). Never updated, never deleted — retention removes expired rows under the
# privileged connection.
READ_APPEND_TABLES = ("forecast_snapshots",)

ALL_TABLES = READ_ONLY_TABLES + READ_APPEND_TABLES


def upgrade() -> None:
    for table in ALL_TABLES:
        # Idempotent where a platform already did it, and explicit where none has, so the property
        # under test is the same in a test cluster and in a real project.
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(
            f"""
            CREATE POLICY {table}_request_read ON {table}
            FOR SELECT
            TO {RESTRICTED_ROLE}
            USING (true)
            """
        )

    for table in READ_APPEND_TABLES:
        # `WITH CHECK` only: an INSERT policy has no `USING` clause, since there is no existing row
        # to test. Separate from the read policy so that appending stays visible as its own grant.
        op.execute(
            f"""
            CREATE POLICY {table}_request_append ON {table}
            FOR INSERT
            TO {RESTRICTED_ROLE}
            WITH CHECK (true)
            """
        )


def downgrade() -> None:
    for table in READ_APPEND_TABLES:
        op.execute(f"DROP POLICY IF EXISTS {table}_request_append ON {table}")

    for table in ALL_TABLES:
        op.execute(f"DROP POLICY IF EXISTS {table}_request_read ON {table}")
        # Back to what 0002 intended: reachable through the grant alone. On a platform that enables
        # RLS for you this leaves the tables *more* reachable than they were before 0004 rather
        # than less — the deny-all state this migration exists to correct is not worth restoring.
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")
