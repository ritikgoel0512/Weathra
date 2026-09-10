"""Repair the grant `0012` made to the wrong role.

`0012` created ``weather_watches`` correctly — table, index, forced Row Level Security, owner-only
policy — and then granted the four verbs to **``weathra_api``**, which is the LOGIN role `0003`
creates, rather than to **``weathra_request``**, the role a request-scoped session assumes and the
only role the policies constrain. Two things followed, and this revision undoes both:

* the request path could not touch the table at all — every read and write raised *permission
  denied*, because the assumed role held no privilege on it;
* the login role held four privileges it must never hold. Row Level Security still applied to it,
  so no row was exposed, but ``specs/authentication``'s invariant is that **the role switch is what
  grants access**, and a table the login role can reach directly is a table a request could reach
  without switching.

`0012` itself is corrected in place for databases that have not run it yet. This revision exists
for the ones that have — production among them — where the wrong grant is already committed and
editing the earlier file changes nothing. Both paths end in the same state, and running either
twice is harmless: ``GRANT`` is idempotent, and the ``REVOKE`` is guarded on the role existing,
because a database built from the corrected `0012` may have no ``weathra_api`` at all.

Revision ID: 0013_weather_watch_grant_repair
Revises: 0012_weather_watches
"""

from __future__ import annotations

from alembic import op

revision: str = "0013_weather_watch_grant_repair"
down_revision: str | None = "0012_weather_watches"
branch_labels: str | None = None
depends_on: str | None = None

TABLE = "weather_watches"
# The assumed role, which the policies constrain and which the request path needs.
RESTRICTED_ROLE = "weathra_request"
# The login role, which must hold nothing directly.
LOGIN_ROLE = "weathra_api"


def _revoke_from_the_login_role() -> None:
    """Guarded, because `0003` is the only thing that creates this role and a test database that
    ran the corrected `0012` never granted it anything."""
    op.execute(
        f"""
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{LOGIN_ROLE}') THEN
                EXECUTE 'REVOKE ALL ON {TABLE} FROM {LOGIN_ROLE}';
            END IF;
        END
        $$
        """
    )


def upgrade() -> None:
    _revoke_from_the_login_role()
    op.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON {TABLE} TO {RESTRICTED_ROLE}")


def downgrade() -> None:
    """Down to `0012` as it is *now written*, not as it was written when it was wrong.

    Restoring the defect would mean deliberately re-granting the login role, which is not something
    a downgrade should do. So this returns the table to having no grant beyond the restricted
    role's, and `0012`'s own downgrade removes that.
    """
    _revoke_from_the_login_role()
